//! 独立、无窗口、无音频的预览取帧；不向正在播放的 mpv 实例发送命令。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

static BUSY: AtomicBool = AtomicBool::new(false);
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub struct RequestGuard;

impl RequestGuard {
    pub fn acquire() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "预览取帧正在进行".to_string())
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::AcqRel);
}

pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

pub fn validate_time(seconds: f64) -> Result<(), String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("预览时间无效".to_string());
    }
    Ok(())
}

#[cfg(windows)]
pub fn capture(
    library: std::path::PathBuf,
    media: String,
    seconds: f64,
    token: u64,
) -> Result<Vec<u8>, String> {
    windows::capture(library, media, seconds, token)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows_sys::Win32::System::LibraryLoader::{
        GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
    };

    type Create = unsafe extern "C" fn() -> *mut c_void;
    type SetOption = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    type Initialize = unsafe extern "C" fn(*mut c_void) -> c_int;
    type Command = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int;
    type WaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *const Event;
    type Destroy = unsafe extern "C" fn(*mut c_void);

    // mpv/client.h 的 mpv_event ABI；只读取事件 ID 和错误码。
    #[repr(C)]
    struct Event {
        id: c_int,
        error: c_int,
        reply_userdata: u64,
        data: *mut c_void,
    }

    struct Library(HMODULE);
    impl Drop for Library {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.0) };
        }
    }

    struct Decoder {
        // DLL 必须比 handle 活得更久；Drop 先销毁 mpv，随后才卸载 DLL。
        _library: Library,
        handle: *mut c_void,
        destroy: Destroy,
    }
    impl Drop for Decoder {
        fn drop(&mut self) {
            unsafe { (self.destroy)(self.handle) };
        }
    }

    struct OutputDirectory(PathBuf);
    impl Drop for OutputDirectory {
        fn drop(&mut self) {
            // 仅清理由本次请求新建的唯一目录和取帧文件，不递归删除任何目录。
            if let Ok(entries) = fs::read_dir(&self.0) {
                for entry in entries.flatten() {
                    if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
            let _ = fs::remove_dir(&self.0);
        }
    }

    unsafe fn symbol<T: Copy>(library: HMODULE, name: &[u8]) -> Result<T, String> {
        let address = GetProcAddress(library, name.as_ptr())
            .ok_or_else(|| "libmpv 缺少预览取帧接口".to_string())?;
        Ok(std::mem::transmute_copy(&address))
    }

    fn option(set: SetOption, handle: *mut c_void, name: &str, value: &str) -> Result<(), String> {
        let name = CString::new(name).map_err(|_| "预览选项无效")?;
        let value = CString::new(value).map_err(|_| "预览选项值无效")?;
        let result = unsafe { set(handle, name.as_ptr(), value.as_ptr()) };
        if result < 0 {
            return Err(format!(
                "设置预览选项失败：{} ({result})",
                name.to_string_lossy()
            ));
        }
        Ok(())
    }

    pub fn capture(
        library_path: PathBuf,
        media: String,
        seconds: f64,
        token: u64,
    ) -> Result<Vec<u8>, String> {
        validate_time(seconds)?;
        if generation() != token {
            return Err("预览已取消".to_string());
        }
        let validated = fs::canonicalize(&media).map_err(|_| "预览视频不存在")?;
        if !validated.is_file() {
            return Err("预览路径不是文件".to_string());
        }
        // 缓存仅放 EXE 同级；每次最多写一张 320×180 范围内的 JPEG，读取后立即清理。
        let parent = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("无法定位预览缓存目录")?
            .join("PreviewCache");
        fs::create_dir_all(&parent).map_err(|e| format!("无法创建预览缓存目录：{e}"))?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let output = parent.join(format!("{}-{stamp}", std::process::id()));
        fs::create_dir(&output).map_err(|e| e.to_string())?;
        let output = OutputDirectory(output);

        let wide: Vec<u16> = library_path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
        };
        if module.is_null() {
            return Err(format!(
                "无法加载预览内核：{}",
                std::io::Error::last_os_error()
            ));
        }
        let library = Library(module);
        let (create, set, initialize, command, wait, destroy): (
            Create,
            SetOption,
            Initialize,
            Command,
            WaitEvent,
            Destroy,
        ) = unsafe {
            (
                symbol(module, b"mpv_create\0")?,
                symbol(module, b"mpv_set_option_string\0")?,
                symbol(module, b"mpv_initialize\0")?,
                symbol(module, b"mpv_command\0")?,
                symbol(module, b"mpv_wait_event\0")?,
                symbol(module, b"mpv_terminate_destroy\0")?,
            )
        };
        let handle = unsafe { create() };
        if handle.is_null() {
            return Err("无法创建预览解码器".to_string());
        }
        let decoder = Decoder {
            _library: library,
            handle,
            destroy,
        };
        for (name, value) in [
            ("config", "no"),
            ("load-scripts", "no"),
            ("terminal", "no"),
            ("vo", "image"),
            ("vo-image-format", "jpg"),
            ("vo-image-jpeg-quality", "75"),
            ("audio", "no"),
            ("sub", "no"),
            ("hwdec", "no"),
            ("vd-lavc-threads", "2"),
            ("frames", "1"),
            ("idle", "yes"),
            ("keep-open", "no"),
            ("pause", "no"),
            ("ytdl", "no"),
            ("demuxer-max-bytes", "8MiB"),
            ("demuxer-max-back-bytes", "0"),
            (
                "vf",
                "lavfi=[scale=w='min(320,180*dar)':h='min(180,320/dar)',setsar=1]",
            ),
        ] {
            option(set, handle, name, value)?;
        }
        option(set, handle, "start", &format!("{seconds:.3}"))?;
        option(set, handle, "vo-image-outdir", &output.0.to_string_lossy())?;
        let result = unsafe { initialize(handle) };
        if result < 0 {
            return Err(format!("初始化预览解码器失败 ({result})"));
        }
        // 保留用户原路径的 UTF-8 表示；不把 canonicalize 的 Windows 长路径前缀传给 mpv。
        let file = CString::new(media).map_err(|_| "预览文件路径无效")?;
        let load = CString::new("loadfile").unwrap();
        let args = [load.as_ptr(), file.as_ptr(), ptr::null()];
        let result = unsafe { command(handle, args.as_ptr()) };
        if result < 0 {
            return Err(format!("加载预览视频失败 ({result})"));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = loop {
            if generation() != token {
                break Err("预览已取消".to_string());
            }
            if Instant::now() >= deadline {
                break Err("预览取帧超时".to_string());
            }
            let event = unsafe { wait(handle, 0.05).as_ref() }.ok_or("预览事件无效")?;
            // MPV_EVENT_END_FILE = 7；输出文件已关闭，可以安全读取。
            if event.id == 7 {
                let image = fs::read_dir(&output.0)
                    .map_err(|e| e.to_string())?
                    .filter_map(Result::ok)
                    .find(|entry| entry.path().extension().is_some_and(|ext| ext == "jpg"));
                break match image {
                    Some(image) => fs::read(image.path()).map_err(|e| e.to_string()),
                    None => Err("该时间点没有可预览的画面".to_string()),
                };
            }
            if event.id == 1 || event.error < 0 {
                break Err(format!("预览解码失败 ({})", event.error));
            }
        };
        drop(decoder);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_times() {
        for seconds in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(validate_time(seconds).is_err());
        }
        assert!(validate_time(0.0).is_ok());
    }

    #[test]
    fn bounds_concurrency_and_cancels_generation() {
        let guard = RequestGuard::acquire().unwrap();
        assert!(RequestGuard::acquire().is_err());
        let previous = generation();
        cancel();
        assert_ne!(generation(), previous);
        drop(guard);
        assert!(RequestGuard::acquire().is_ok());
    }
}
