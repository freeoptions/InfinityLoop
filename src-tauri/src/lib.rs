use serde::Serialize;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, Window};

#[derive(Default)]
pub struct AppState {
    player: Mutex<Option<MpvController>>,
}

#[cfg(windows)]
static ORIGINAL_SURFACE_WNDPROC: std::sync::atomic::AtomicIsize =
    std::sync::atomic::AtomicIsize::new(0);

#[cfg(windows)]
unsafe extern "system" fn surface_window_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, HTTRANSPARENT, MA_NOACTIVATE, WM_MOUSEACTIVATE,
        WM_NCHITTEST, WNDPROC,
    };

    match message {
        WM_NCHITTEST => return HTTRANSPARENT as isize,
        WM_MOUSEACTIVATE => return MA_NOACTIVATE as isize,
        _ => {}
    }

    let original = ORIGINAL_SURFACE_WNDPROC.load(Ordering::Relaxed);
    if original == 0 {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }

    let original_proc: WNDPROC = std::mem::transmute(original);
    CallWindowProcW(original_proc, hwnd, message, wparam, lparam)
}

#[cfg(windows)]
fn install_surface_input_passthrough(
    surface: windows_sys::Win32::Foundation::HWND,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC,
    };

    let passthrough_proc = surface_window_proc as *const () as isize;
    let current_proc = unsafe { GetWindowLongPtrW(surface, GWLP_WNDPROC) };
    if current_proc == passthrough_proc {
        return Ok(());
    }

    let previous_proc = unsafe { SetWindowLongPtrW(surface, GWLP_WNDPROC, passthrough_proc) };
    if previous_proc == 0 {
        return Err("设置 mpv 画面输入穿透失败".to_string());
    }

    ORIGINAL_SURFACE_WNDPROC.store(previous_proc, Ordering::Relaxed);
    Ok(())
}

fn diagnostic_log_path(file_name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(file_name)))
        .unwrap_or_else(|| std::env::temp_dir().join(file_name))
}

fn write_diagnostic_log(message: impl AsRef<str>) {
    let path = diagnostic_log_path("InfinityLoop.log");
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    pub path: String,
    pub name: String,
    #[serde(rename = "webkitRelativePath")]
    pub webkit_relative_path: String,
    pub size: u64,
    pub last_modified: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    phase: String,
    scanned: usize,
    candidates: usize,
    current_path: String,
    finished: bool,
}

struct MpvController {
    child: Child,
    pipe: Arc<Mutex<File>>,
    surface: isize,
    playlist_file: PathBuf,
}

impl MpvController {
    fn send(&self, command: Vec<Value>) -> Result<(), String> {
        let payload = serde_json::to_vec(&json!({ "command": command }))
            .map_err(|error| format!("序列化 mpv 命令失败：{error}"))?;
        let mut pipe = self
            .pipe
            .lock()
            .map_err(|_| "mpv 通信管道已损坏".to_string())?;
        pipe.write_all(&payload)
            .and_then(|_| pipe.write_all(b"\n"))
            .and_then(|_| pipe.flush())
            .map_err(|error| format!("发送 mpv 命令失败：{error}"))
    }

    fn observe_default_properties(&self) -> Result<(), String> {
        let properties = [
            "time-pos",
            "duration",
            "pause",
            "playlist-pos",
            "filename",
            "video-codec",
            "video-format",
            "hwdec-current",
            "track-list",
        ];

        for (id, property) in properties.iter().enumerate() {
            self.send(vec![
                json!("observe_property"),
                json!(id + 1),
                json!(property),
            ])?;
        }
        Ok(())
    }

    fn load_playlist(&self, paths: &[String], index: usize) -> Result<(), String> {
        if paths.is_empty() {
            return Err("播放列表为空".to_string());
        }

        let playlist_content = format!(
            "#EXTM3U\n{}\n",
            paths
                .iter()
                .map(|path| path.replace('\r', "").replace('\n', ""))
                .collect::<Vec<_>>()
                .join("\n")
        );
        fs::write(&self.playlist_file, playlist_content)
            .map_err(|error| format!("写入 mpv 播放列表失败：{error}"))?;
        write_diagnostic_log(format!(
            "load playlist: entries={}, index={}, file={}",
            paths.len(),
            index,
            self.playlist_file.display()
        ));

        self.send(vec![
            json!("loadlist"),
            json!(self.playlist_file.to_string_lossy().into_owned()),
            json!("replace"),
        ])?;

        self.send(vec![
            json!("playlist-play-index"),
            json!(index.min(paths.len() - 1)),
        ])
    }

    fn shutdown(&mut self) {
        write_diagnostic_log(format!("stopping mpv: pid={}", self.child.id()));
        let _ = self.send(vec![json!("quit")]);
        thread::sleep(Duration::from_millis(80));
        let _ = self.child.kill();
        destroy_native_surface(self.surface);
        let _ = fs::remove_file(&self.playlist_file);
    }
}

impl Drop for MpvController {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
fn pick_folder() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        return Ok(rfd::FileDialog::new()
            .set_title("选择视频文件夹")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned()));
    }

    #[cfg(not(windows))]
    {
        Err("当前版本仅支持 Windows".to_string())
    }
}

#[tauri::command]
fn scan_folder(
    app: AppHandle,
    path: String,
    include_subfolders: bool,
) -> Result<Vec<MediaFile>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err("所选路径不是有效文件夹".to_string());
    }

    let mut files = Vec::new();
    let mut scanned = 0usize;
    scan_directory(
        &app,
        &root,
        &root,
        include_subfolders,
        &mut scanned,
        &mut files,
    )?;

    files.sort_by(|left, right| {
        left.webkit_relative_path
            .to_lowercase()
            .cmp(&right.webkit_relative_path.to_lowercase())
    });

    let _ = app.emit(
        "folder-scan-progress",
        ScanProgress {
            phase: "完成".to_string(),
            scanned,
            candidates: files.len(),
            current_path: root.to_string_lossy().into_owned(),
            finished: true,
        },
    );

    Ok(files)
}

fn scan_directory(
    app: &AppHandle,
    root: &Path,
    current: &Path,
    include_subfolders: bool,
    scanned: &mut usize,
    files: &mut Vec<MediaFile>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|error| format!("读取文件夹失败：{} ({error})", current.display()))?;

    for entry in entries.flatten() {
        *scanned += 1;
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            if include_subfolders {
                scan_directory(app, root, &path, include_subfolders, scanned, files)?;
            }
        } else if file_type.is_file() && is_supported_media(&path) {
            let metadata = entry.metadata().ok();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();

            files.push(MediaFile {
                path: path.to_string_lossy().into_owned(),
                name,
                webkit_relative_path: relative,
                size: metadata.as_ref().map(|value| value.len()).unwrap_or(0),
                last_modified: metadata
                    .and_then(|value| value.modified().ok())
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_secs())
                    .unwrap_or(0),
            });
        }

        if *scanned == 1 || *scanned % 25 == 0 {
            let _ = app.emit(
                "folder-scan-progress",
                ScanProgress {
                    phase: "扫描文件夹".to_string(),
                    scanned: *scanned,
                    candidates: files.len(),
                    current_path: path.to_string_lossy().into_owned(),
                    finished: false,
                },
            );
        }
    }

    Ok(())
}

fn is_supported_media(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };

    matches!(
        extension.to_ascii_lowercase().as_str(),
        "mp4"
            | "m4v"
            | "mkv"
            | "avi"
            | "mov"
            | "qt"
            | "wmv"
            | "asf"
            | "ts"
            | "m2ts"
            | "mts"
            | "mxf"
            | "flv"
            | "f4v"
            | "webm"
            | "ogv"
            | "ogm"
            | "3gp"
            | "3g2"
            | "rm"
            | "rmvb"
            | "vob"
            | "mpg"
            | "mpeg"
            | "m2v"
            | "divx"
            | "mp3"
            | "m4a"
            | "aac"
            | "wav"
            | "flac"
            | "ogg"
            | "oga"
            | "opus"
            | "wma"
            | "ape"
            | "tta"
            | "ac3"
            | "dts"
    )
}

#[tauri::command]
fn mpv_start(window: Window, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (window, app, state);
        return Err("当前版本仅支持 Windows".to_string());
    }

    #[cfg(windows)]
    {
        let mut player_slot = state
            .player
            .lock()
            .map_err(|_| "播放器状态不可用".to_string())?;
        if player_slot.is_some() {
            return Ok(());
        }

        let surface = create_native_surface(&window)?;
        let Some(mpv_path) = find_resource_file(&app, "mpv.exe") else {
            destroy_native_surface(surface);
            return Err(
                "没有找到 mpv 播放内核，请确认 src-tauri/resources/mpv/mpv.exe 已放置。"
                    .to_string(),
            );
        };

        let input_conf = find_resource_file(&app, "portable_config/input.conf");
        let mpv_log_path = diagnostic_log_path("InfinityLoop-mpv.log");
        let pipe_name = format!(
            r"\\.\pipe\InfinityLoop-mpv-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );

        let mut command = Command::new(&mpv_path);
        command.args([
            "--idle=yes",
            "--force-window=yes",
            "--no-terminal",
            "--no-osc",
            "--osd-level=0",
            "--no-config",
            "--keep-open=no",
            "--hwdec=auto-safe",
            "--msg-level=all=info",
            &format!("--input-ipc-server={pipe_name}"),
            &format!("--wid={surface}"),
        ]);
        command.arg(format!("--log-file={}", mpv_log_path.display()));

        write_diagnostic_log(format!(
            "starting mpv: path={}, surface={}, parent={}, pipe={}, log={}",
            mpv_path.display(),
            surface,
            window
                .hwnd()
                .map(|hwnd| hwnd.0 as isize)
                .unwrap_or_default(),
            pipe_name,
            mpv_log_path.display()
        ));

        if let Some(input_conf) = input_conf {
            command.arg(format!("--input-conf={}", input_conf.display()));
        }

        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                destroy_native_surface(surface);
                write_diagnostic_log(format!("mpv spawn failed: {error}"));
                format!("启动 mpv 失败：{error}")
            })?;
        write_diagnostic_log(format!("mpv spawned: pid={}", child.id()));

        let pipe = match open_named_pipe(&pipe_name, &mut child) {
            Ok(file) => Arc::new(Mutex::new(file)),
            Err(error) => {
                let _ = child.kill();
                destroy_native_surface(surface);
                return Err(error);
            }
        };

        let controller = MpvController {
            child,
            pipe: pipe.clone(),
            surface,
            playlist_file: diagnostic_log_path("InfinityLoop-playlist.m3u8"),
        };

        controller.observe_default_properties()?;
        write_diagnostic_log("mpv IPC connected and properties subscribed");
        spawn_mpv_reader(pipe, app);
        *player_slot = Some(controller);
        Ok(())
    }
}

#[tauri::command]
fn mpv_load_playlist(
    paths: Vec<String>,
    index: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let player_slot = state
        .player
        .lock()
        .map_err(|_| "播放器状态不可用".to_string())?;
    let player = player_slot
        .as_ref()
        .ok_or_else(|| "mpv 尚未启动".to_string())?;
    player.load_playlist(&paths, index)
}

#[tauri::command]
fn mpv_command(command: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    let player_slot = state
        .player
        .lock()
        .map_err(|_| "播放器状态不可用".to_string())?;
    let player = player_slot
        .as_ref()
        .ok_or_else(|| "mpv 尚未启动".to_string())?;
    player.send(command.into_iter().map(Value::String).collect())
}

#[tauri::command]
fn mpv_resize(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    visible: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let player_slot = state
        .player
        .lock()
        .map_err(|_| "播放器状态不可用".to_string())?;
    if let Some(player) = player_slot.as_ref() {
        resize_native_surface(player.surface, x, y, width, height, visible);
    }
    Ok(())
}

#[tauri::command]
fn mpv_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mut player_slot = state
        .player
        .lock()
        .map_err(|_| "播放器状态不可用".to_string())?;
    player_slot.take();
    Ok(())
}

#[tauri::command]
fn set_fullscreen(window: Window, fullscreen: bool) -> Result<(), String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| format!("切换全屏失败：{error}"))
}

fn spawn_mpv_reader(pipe: Arc<Mutex<File>>, app: AppHandle) {
    thread::spawn(move || {
        write_diagnostic_log("mpv reader thread started");
        let Ok(reader_file) = pipe
            .lock()
            .ok()
            .and_then(|file| file.try_clone().ok())
            .ok_or(())
        else {
            write_diagnostic_log("mpv reader could not clone IPC pipe");
            return;
        };

        let reader = BufReader::new(reader_file);
        for line in reader.lines().flatten() {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                if !line.trim().is_empty() {
                    write_diagnostic_log(format!("invalid mpv IPC line: {line}"));
                }
                continue;
            };

            if message.get("error").is_some()
                || message.get("event").and_then(Value::as_str) == Some("end-file")
            {
                write_diagnostic_log(format!("mpv IPC event: {message}"));
            }

            if message.get("event").and_then(Value::as_str) == Some("property-change") {
                let _ = app.emit(
                    "mpv-property",
                    json!({
                        "name": message.get("name").cloned().unwrap_or(Value::Null),
                        "value": message.get("data").cloned().unwrap_or(Value::Null)
                    }),
                );
            } else if message.get("event").is_some() {
                let _ = app.emit("mpv-event", message);
            }
        }

        write_diagnostic_log("mpv reader thread ended");
        let _ = app.emit("mpv-event", json!({ "event": "backend-exited" }));
    });
}

#[cfg(windows)]
fn open_named_pipe(path: &str, child: &mut Child) -> Result<File, String> {
    use std::os::windows::io::FromRawHandle;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };

    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    for attempt in 0..120 {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("检查 mpv 状态失败：{error}"))?
        {
            return Err(format!("mpv 启动后立即退出：{status}"));
        }

        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };

        if handle != INVALID_HANDLE_VALUE {
            write_diagnostic_log("named pipe connected");
            return Ok(unsafe { File::from_raw_handle(handle as _) });
        }
        if attempt % 20 == 0 {
            write_diagnostic_log(format!(
                "waiting for mpv named pipe: win32_error={}",
                unsafe { GetLastError() }
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }

    Err("连接 mpv 通信管道超时".to_string())
}

#[cfg(not(windows))]
fn open_named_pipe(_path: &str, _child: &mut Child) -> Result<File, String> {
    Err("当前版本仅支持 Windows".to_string())
}

#[cfg(windows)]
fn find_resource_file(app: &AppHandle, relative: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("resources").join("mpv").join(relative));
        candidates.push(resource_dir.join("mpv").join(relative));
    }

    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(parent) = exe_dir.parent() {
            candidates.push(parent.join("resources").join("mpv").join(relative));
            candidates.push(parent.join("mpv").join(relative));
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("resources")
                .join("mpv")
                .join(relative),
        );
        candidates.push(current_dir.join("resources").join("mpv").join(relative));
    }

    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(windows)]
fn create_native_surface(window: &Window) -> Result<isize, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
        WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    };

    let parent = window
        .hwnd()
        .map_err(|error| format!("获取主窗口句柄失败：{error}"))?;
    let class_name: Vec<u16> = "STATIC".encode_utf16().chain(std::iter::once(0)).collect();

    let surface = unsafe {
        CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
            class_name.as_ptr(),
            null(),
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0,
            0,
            0,
            0,
            parent.0,
            null_mut(),
            null_mut(),
            null(),
        )
    };

    if surface.is_null() {
        return Err("创建 mpv 原生画面区域失败".to_string());
    }

    if let Err(error) = install_surface_input_passthrough(surface) {
        unsafe { DestroyWindow(surface) };
        return Err(error);
    }

    Ok(surface as isize)
}

#[cfg(not(windows))]
fn create_native_surface(_window: &Window) -> Result<isize, String> {
    Err("当前版本仅支持 Windows".to_string())
}

#[cfg(windows)]
fn resize_native_surface(surface: isize, x: i32, y: i32, width: i32, height: i32, visible: bool) {
    use std::ptr::null_mut;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_SHOWWINDOW,
    };

    if surface == 0 {
        return;
    }

    unsafe {
        let flags = SWP_NOACTIVATE
            | SWP_NOOWNERZORDER
            | if visible {
                SWP_SHOWWINDOW
            } else {
                SWP_HIDEWINDOW
            };
        SetWindowPos(
            surface as _,
            null_mut(),
            x,
            y,
            width.max(1),
            height.max(1),
            flags,
        );
    }
}

#[cfg(not(windows))]
fn resize_native_surface(
    _surface: isize,
    _x: i32,
    _y: i32,
    _width: i32,
    _height: i32,
    _visible: bool,
) {
}

#[cfg(windows)]
fn destroy_native_surface(surface: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow;

    if surface != 0 {
        unsafe {
            DestroyWindow(surface as _);
        }
    }
}

#[cfg(not(windows))]
fn destroy_native_surface(_surface: isize) {}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示软件", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("InfinityLoop - 本地视频播放器")
        .show_menu_on_left_click(false)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    if window.is_visible().unwrap_or(true) {
                        let _ = window.hide();
                    } else {
                        show_main_window(&tray.app_handle());
                    }
                }
            }
        });

    #[cfg(windows)]
    {
        const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/icon.ico");
        if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON_BYTES) {
            builder = builder.icon(icon);
        }
    }

    builder.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            scan_folder,
            mpv_start,
            mpv_load_playlist,
            mpv_command,
            mpv_resize,
            mpv_stop,
            set_fullscreen
        ])
        .run(tauri::generate_context!())
        .expect("运行 InfinityLoop 失败");
}
