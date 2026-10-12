use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Listener, Manager, State};
use tauri_plugin_libmpv::MpvExt;

#[derive(Default)]
pub struct PlaybackGate(Mutex<LoadIdentity>);
#[derive(Default)]
struct LoadIdentity {
    generation: u64,
    path: String,
}
#[derive(Default)]
pub struct MediaEvents(Mutex<EventIdentity>);
#[derive(Default)]
struct EventIdentity {
    started: Option<i64>,
    loaded: Option<i64>,
    finished: Option<i64>,
}

impl EventIdentity {
    fn observe(&mut self, value: &Value) {
        match value["event"].as_str() {
            Some("start-file") => {
                self.started = value["playlist_entry_id"].as_i64();
                self.loaded = None;
                self.finished = None;
            }
            Some("file-loaded") => self.loaded = self.started,
            Some("end-file") if value["playlist_entry_id"].as_i64() == self.started => {
                self.loaded = None;
                if value["reason"] == "eof" || value["reason"] == 0 {
                    self.finished = self.started;
                }
            }
            _ => {}
        }
    }
}

pub fn install(app: &AppHandle) {
    let handle = app.clone();
    app.listen_any("mpv-event-main", move |event| {
        let Ok(value) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        // 只记录原生有序事件中的媒体 ID，不使用前端当前列表索引。
        let events = handle.state::<MediaEvents>();
        let Ok(mut state) = events.0.lock() else {
            return;
        };
        state.observe(&value);
    });
}

fn normalize(path: &str) -> String {
    let value = path.replace('\\', "/").to_lowercase();
    if let Some(unc) = value.strip_prefix("//?/unc/") {
        return format!("//{unc}");
    }
    value.strip_prefix("//?/").unwrap_or(&value).to_string()
}
fn get(app: &AppHandle, name: &str, format: &str) -> Value {
    app.mpv()
        .get_property(name.into(), format.into(), "main")
        .unwrap_or(Value::Null)
}
fn set(app: &AppHandle, name: &str, value: Value) -> Result<(), String> {
    app.mpv()
        .set_property(name, &value, "main")
        .map_err(|error| error.to_string())
}
fn media_id(app: &AppHandle) -> Option<i64> {
    get(app, "playlist/0/id", "int64").as_i64()
}

fn loadfile_args(path: &str, start: f64, autoplay: bool) -> Vec<Value> {
    // libmpv-wrapper 使用 mpv_command 的字符串参数接口，不支持 NODE_MAP。
    // 第四参数必须使用 mpv 的 opt=value 列表；文件路径始终是独立参数。
    vec![
        json!(path),
        json!("replace"),
        json!(-1),
        json!(format!(
            "start={start},pause={}",
            if autoplay { "no" } else { "yes" }
        )),
    ]
}

#[tauri::command]
pub fn playback_load(
    app: AppHandle,
    gate: State<PlaybackGate>,
    generation: u64,
    path: String,
    start: f64,
    speed: f64,
    autoplay: bool,
    loop_single: bool,
) -> Result<(), String> {
    if !start.is_finite() || start < 0.0 || !speed.is_finite() || !(0.5..=2.0).contains(&speed) {
        return Err("无效的播放参数".into());
    }
    let mut identity = gate.0.lock().map_err(|_| "播放锁不可用")?;
    if generation < identity.generation {
        return Ok(());
    }
    set(&app, "ab-loop-a", json!("no"))?;
    set(&app, "ab-loop-b", json!("no"))?;
    set(&app, "end", json!("none"))?;
    set(
        &app,
        "loop-file",
        json!(if loop_single { "inf" } else { "no" }),
    )?;
    set(&app, "speed", json!(speed))?;
    identity.generation = generation;
    identity.path = normalize(&path);
    // 由内核在加载正确文件时应用起点与自动播放设置。
    app.mpv()
        .command("loadfile", &loadfile_args(&path, start, autoplay), "main")
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn playback_snapshot(
    app: AppHandle,
    gate: State<PlaybackGate>,
    events: State<MediaEvents>,
) -> Result<Value, String> {
    let identity = gate.0.lock().map_err(|_| "播放锁不可用")?;
    let (loaded, finished) = {
        let event = events.0.lock().map_err(|_| "媒体事件锁不可用")?;
        (event.loaded, event.finished)
    };
    let id = media_id(&app);
    if id.is_some() && id == finished {
        let path = get(&app, "playlist/0/filename", "string")
            .as_str()
            .map(normalize)
            .unwrap_or_default();
        if path == identity.path {
            return Ok(
                json!({ "generation": identity.generation, "mediaId": id, "path": path, "ended": true }),
            );
        }
    }
    let path = get(&app, "path", "string")
        .as_str()
        .map(normalize)
        .unwrap_or_default();
    if id.is_none() || id != loaded || path != identity.path {
        return Ok(Value::Null);
    }
    let position = get(&app, "time-pos", "double");
    let duration = get(&app, "duration", "double");
    let paused = get(&app, "pause", "flag");
    let eof = get(&app, "eof-reached", "flag");
    let speed = get(&app, "speed", "double");
    if media_id(&app) != id || events.0.lock().map_err(|_| "媒体事件锁不可用")?.loaded != id
    {
        return Ok(Value::Null);
    }
    Ok(
        json!({ "generation": identity.generation, "mediaId": id, "path": path,
        "position": position, "duration": duration, "paused": paused, "eof": eof, "speed": speed }),
    )
}

#[tauri::command]
pub fn playback_set(
    app: AppHandle,
    gate: State<PlaybackGate>,
    events: State<MediaEvents>,
    generation: u64,
    media_id: i64,
    name: String,
    value: Value,
) -> Result<bool, String> {
    let identity = gate.0.lock().map_err(|_| "播放锁不可用")?;
    if identity.generation != generation
        || get(&app, "playlist/0/id", "int64").as_i64() != Some(media_id)
        || events.0.lock().map_err(|_| "媒体事件锁不可用")?.loaded != Some(media_id)
        || get(&app, "path", "string")
            .as_str()
            .map(normalize)
            .as_deref()
            != Some(identity.path.as_str())
    {
        return Ok(false);
    }
    if !matches!(
        name.as_str(),
        "time-pos" | "pause" | "speed" | "ab-loop-a" | "ab-loop-b" | "end" | "loop-file"
    ) {
        return Err("不支持的播放属性".into());
    }
    if let Some(number) = value.as_f64() {
        if !number.is_finite() || number < 0.0 {
            return Err("播放属性超出范围".into());
        }
    }
    set(&app, &name, value)?;
    Ok(true)
}

#[tauri::command]
pub fn playback_failure(
    app: AppHandle,
    gate: State<PlaybackGate>,
    generation: u64,
    media_id: i64,
) -> Result<bool, String> {
    let identity = gate.0.lock().map_err(|_| "播放锁不可用")?;
    let path = get(&app, "playlist/0/filename", "string");
    Ok(identity.generation == generation
        && self::media_id(&app) == Some(media_id)
        && path.as_str().map(normalize).as_deref() == Some(identity.path.as_str()))
}

#[tauri::command]
pub fn playback_file_metadata(path: String) -> Result<Value, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Ok(json!({ "size": metadata.len(), "lastModified": modified }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_identity_preserves_directory() {
        assert_eq!(normalize(r"D:\Videos\A.mp4"), normalize("d:/videos/a.mp4"));
        assert_ne!(normalize("d:/first/a.mp4"), normalize("d:/second/a.mp4"));
        assert_eq!(
            normalize(r"\\?\D:\Videos\A.mp4"),
            normalize("d:/videos/a.mp4")
        );
        assert_eq!(
            normalize(r"\\?\UNC\server\share\a.mp4"),
            normalize(r"\\server\share\a.mp4")
        );
    }

    #[test]
    fn old_end_does_not_clear_new_media() {
        let mut state = EventIdentity::default();
        state.observe(&json!({"event":"start-file","playlist_entry_id":1}));
        state.observe(&json!({"event":"file-loaded"}));
        state.observe(&json!({"event":"start-file","playlist_entry_id":2}));
        state.observe(&json!({"event":"file-loaded"}));
        state.observe(&json!({"event":"end-file","playlist_entry_id":1,"reason":"eof"}));
        assert_eq!(state.loaded, Some(2));
        assert_eq!(state.finished, None);
        state.observe(&json!({"event":"end-file","playlist_entry_id":2,"reason":"stop"}));
        assert_eq!(state.finished, None);
    }

    #[test]
    fn only_natural_completion_is_finished() {
        let mut state = EventIdentity::default();
        state.observe(&json!({"event":"start-file","playlist_entry_id":7}));
        state.observe(&json!({"event":"end-file","playlist_entry_id":7,"reason":"error"}));
        assert_eq!(state.finished, None);
        state.observe(&json!({"event":"end-file","playlist_entry_id":7,"reason":"eof"}));
        assert_eq!(state.finished, Some(7));
    }
}

#[cfg(all(test, windows))]
#[path = "playback_ffi_tests.rs"]
mod ffi_tests;
