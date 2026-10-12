use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();
static LOG: OnceLock<Mutex<()>> = OnceLock::new();
pub fn begin() {
    START.get_or_init(Instant::now);
}
pub fn record(stage: &str, frontend_ms: Option<f64>) {
    if !stage
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || stage.len() > 64
    {
        return;
    }
    let Ok(_guard) = LOG.get_or_init(|| Mutex::new(())).lock() else {
        return;
    };
    let Some(parent) = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
    else {
        return;
    };
    let path = parent.join("InfinityLoop-startup.log");
    // 最多两份 256 KiB 日志，阶段数据不含真实文件路径。
    if std::fs::metadata(&path)
        .map(|m| m.len() >= 256 * 1024)
        .unwrap_or(false)
    {
        let previous = parent.join("InfinityLoop-startup.previous.log");
        if std::fs::copy(&path, previous).is_err() {
            return;
        }
        if std::fs::write(&path, b"").is_err() {
            return;
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let elapsed = START.get_or_init(Instant::now).elapsed().as_millis();
        let _ = writeln!(
            file,
            "stage={stage} process_ms={elapsed} frontend_ms={:.1}",
            frontend_ms.unwrap_or(0.0)
        );
    }
}
#[tauri::command]
pub fn record_startup_stage(stage: String, frontend_ms: f64) {
    if frontend_ms.is_finite() && frontend_ms >= 0.0 {
        record(&stage, Some(frontend_ms));
    }
}
