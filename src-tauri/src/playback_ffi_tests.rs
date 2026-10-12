//! 直接验证交付 DLL 的参数协议；只使用自建视频、无窗口/无音频的隔离内核。
use super::{loadfile_args, normalize, EventIdentity};
use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr, CString};
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
};

type Create = unsafe extern "C" fn(
    *const c_char,
    *const c_char,
    unsafe extern "C" fn(*const c_char, *mut c_void),
    *mut c_void,
) -> *mut c_void;
type Destroy = unsafe extern "C" fn(*mut c_void);
type Call = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_char;
type Free = unsafe extern "C" fn(*mut c_char);

struct Native {
    create: Create,
    destroy: Destroy,
    command: Call,
    set: Call,
    get: Call,
    free: Free,
}
static NATIVE: OnceLock<Native> = OnceLock::new();
static EVENTS: OnceLock<Mutex<EventIdentity>> = OnceLock::new();

fn native() -> &'static Native {
    NATIVE.get_or_init(|| unsafe {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lib/libmpv-wrapper.dll");
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let module = LoadLibraryExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        );
        assert!(
            !module.is_null(),
            "无法加载测试 DLL：{}",
            std::io::Error::last_os_error()
        );
        // wrapper 有事件线程；保持 DLL 至测试进程结束，避免回调时卸载代码。
        unsafe fn symbol<T: Copy>(module: *mut c_void, name: &[u8]) -> T {
            std::mem::transmute_copy(&GetProcAddress(module, name.as_ptr()).unwrap())
        }
        Native {
            create: symbol(module, b"mpv_wrapper_create\0"),
            destroy: symbol(module, b"mpv_wrapper_destroy\0"),
            command: symbol(module, b"mpv_wrapper_command\0"),
            set: symbol(module, b"mpv_wrapper_set_property\0"),
            get: symbol(module, b"mpv_wrapper_get_property\0"),
            free: symbol(module, b"mpv_wrapper_free\0"),
        }
    })
}

unsafe extern "C" fn event_callback(event: *const c_char, _: *mut c_void) {
    if event.is_null() {
        return;
    }
    let parsed = serde_json::from_slice::<Value>(CStr::from_ptr(event).to_bytes());
    (NATIVE.get().unwrap().free)(event as *mut c_char);
    if let Ok(value) = parsed {
        if let Ok(mut events) = EVENTS
            .get_or_init(|| Mutex::new(EventIdentity::default()))
            .lock()
        {
            events.observe(&value);
        }
    }
}

struct Instance(*mut c_void);
impl Drop for Instance {
    fn drop(&mut self) {
        unsafe { (native().destroy)(self.0) };
    }
}
impl Instance {
    fn call(&self, function: Call, name: &str, value: &str) -> Value {
        let name = CString::new(name).unwrap();
        let value = CString::new(value).unwrap();
        unsafe {
            let response = function(self.0, name.as_ptr(), value.as_ptr());
            assert!(!response.is_null());
            let result = serde_json::from_slice(CStr::from_ptr(response).to_bytes()).unwrap();
            (native().free)(response);
            result
        }
    }
    fn get(&self, name: &str, format: &str) -> Value {
        self.call(native().get, name, format)["data"].clone()
    }
    fn set(&self, name: &str, value: Value) {
        let response = self.call(native().set, name, &value.to_string());
        assert!(response.get("error").is_none(), "{name}: {response}");
    }
    fn load(&self, path: &str, start: f64, autoplay: bool) -> i64 {
        let response = self.call(
            native().command,
            "loadfile",
            &json!(loadfile_args(path, start, autoplay)).to_string(),
        );
        assert!(response.get("error").is_none(), "加载失败：{response}");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let id = self.get("playlist/0/id", "int64").as_i64();
            let events = EVENTS
                .get_or_init(|| Mutex::new(EventIdentity::default()))
                .lock()
                .unwrap();
            let loaded = events.loaded;
            drop(events);
            if id.is_some()
                && id == loaded
                && self.get("path", "string").as_str().map(normalize) == Some(normalize(path))
                && self
                    .get("time-pos", "double")
                    .as_f64()
                    .is_some_and(|position| (position - start).abs() < 0.3)
            {
                assert_eq!(self.get("pause", "flag"), json!(!autoplay));
                assert!((self.get("duration", "double").as_f64().unwrap() - 20.0).abs() < 0.1);
                return id.unwrap();
            }
            assert!(Instant::now() < deadline, "等待实际视频加载超时");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

struct Fixtures(PathBuf);
impl Drop for Fixtures {
    fn drop(&mut self) {
        for name in ["视频,= A.y4m", "B.y4m"] {
            let _ = std::fs::remove_file(self.0.join(name));
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

#[test]
fn bundled_bridge_loads_videos_and_applies_resume_and_pause() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "InfinityLoop-playback-test-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir(&directory).unwrap();
    let fixtures = Fixtures(directory);
    let mut video = b"YUV4MPEG2 W16 H16 F10:1 Ip A1:1 C420jpeg\n".to_vec();
    for _ in 0..200 {
        video.extend_from_slice(b"FRAME\n");
        video.extend_from_slice(&[128; 384]);
    }
    for name in ["视频,= A.y4m", "B.y4m"] {
        std::fs::write(fixtures.0.join(name), &video).unwrap();
    }
    let options = CString::new(
        json!({
            "config":"no", "load-scripts":"no", "terminal":"no", "vo":"null",
            "ao":"null", "hwdec":"no", "idle":"yes", "keep-open":"yes",
            "ytdl":"no", "pause":"yes"
        })
        .to_string(),
    )
    .unwrap();
    let observed = CString::new("{}").unwrap();
    let handle = unsafe {
        (native().create)(
            options.as_ptr(),
            observed.as_ptr(),
            event_callback,
            std::ptr::null_mut(),
        )
    };
    assert!(!handle.is_null(), "无法创建隔离测试内核");
    let player = Instance(handle);
    let first = fixtures
        .0
        .join("视频,= A.y4m")
        .to_string_lossy()
        .into_owned();
    let second = fixtures.0.join("B.y4m").to_string_lossy().into_owned();

    // 复现用户日志中的根因：此桥接会把对象转成 JSON 文本，mpv 无法解析。
    let old_args = json!([first, "replace", -1, {"start":"3.25", "pause":"yes"}]);
    assert!(player
        .call(native().command, "loadfile", &old_args.to_string())
        .get("error")
        .is_some());
    for (name, value) in [
        ("ab-loop-a", json!("no")),
        ("ab-loop-b", json!("no")),
        ("end", json!("none")),
        ("loop-file", json!("no")),
        ("speed", json!(1.0)),
    ] {
        player.set(name, value);
    }
    let first_id = player.load(&first, 3.25, false);
    let second_id = player.load(&second, 0.0, false);
    assert_ne!(first_id, second_id);
    let resumed_id = player.load(&first, 7.5, true);
    assert_ne!(resumed_id, second_id);
    player.set("speed", json!(1.5));
    assert_eq!(player.get("speed", "double"), json!(1.5));
    player.set("pause", json!(true));
    assert_eq!(player.get("pause", "flag"), json!(true));
    drop(player);
}
