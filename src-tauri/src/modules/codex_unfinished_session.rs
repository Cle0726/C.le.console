//! Codex 自动切号后的"未完成会话"跟踪与提醒
//!
//! 背景：Codex 桌面端的会话文件（rollout-*.jsonl）保存在本地 CODEX_HOME
//! （默认 ~/.codex），切换账号不会改动这些文件。因此自动切号续任务的关键
//! 是"记住切号前正在进行的会话是哪一条"，切号完成后提醒用户回到 Codex
//! 桌面端继续该会话。
//!
//! 工作流程：
//! 1. 自动切号命中目标账号后、执行切换前调用 `capture_before_auto_switch`
//!    快照当前默认 CODEX_HOME 中最近活跃的会话；
//! 2. 切换成功后调用 `finalize_after_auto_switch`，把快照与新旧账号信息
//!    写入状态文件，向前端发送 `codex:unfinished-session` 事件并弹系统通知；
//! 3. 前端展示提醒，用户回到 Codex 桌面端的历史会话中点选该会话即可继续。

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;
use tauri::Emitter;

use crate::models::codex::CodexAccount;
use crate::modules::{account, codex_account, logger};

const SESSION_DIRS: [&str; 2] = ["sessions", "archived_sessions"];
/// 会话最后活跃时间距今超过该阈值则不再视为"未完成"（72 小时）
const ACTIVE_WINDOW_SECS: i64 = 72 * 3600;
const STATE_FILE_NAME: &str = "codex_unfinished_session.json";
/// rollout 文件头读取上限（字节），session_meta 一定在文件开头
const META_READ_MAX_BYTES: usize = 64 * 1024;

pub const EVENT_NAME: &str = "codex:unfinished-session";

/// 一条"未完成会话"记录（已持久化，供前端查询展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUnfinishedSession {
    /// 会话 ID（rollout 文件名 / session_meta 中的 UUID）
    pub session_id: String,
    /// 会话工作目录
    pub cwd: String,
    /// rollout 文件绝对路径
    pub rollout_path: String,
    /// 会话最后活跃时间（rollout 文件 mtime，Unix 秒）
    pub last_active_at: i64,
    /// 切号前账号
    pub from_account_id: String,
    pub from_email: String,
    /// 切号后账号
    pub to_account_id: String,
    pub to_email: String,
    /// 快照时间（Unix 秒）
    pub captured_at: i64,
    /// 便于用户复制的 CLI 恢复命令
    pub resume_command: String,
}

/// 切号前的临时快照（等待切换完成后补全目标账号信息）
#[derive(Debug, Clone)]
struct PendingCapture {
    session_id: String,
    cwd: String,
    rollout_path: String,
    last_active_at: i64,
    from_account_id: String,
    from_email: String,
    captured_at: i64,
}

static PENDING: OnceLock<Mutex<Option<PendingCapture>>> = OnceLock::new();

fn pending_slot() -> &'static Mutex<Option<PendingCapture>> {
    PENDING.get_or_init(|| Mutex::new(None))
}

fn lock_pending() -> std::sync::MutexGuard<'static, Option<PendingCapture>> {
    match pending_slot().lock() {
        Ok(guard) => guard,
        Err(err) => {
            logger::log_warn("[UnfinishedSession] 检测到锁中毒，恢复继续使用");
            err.into_inner()
        }
    }
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

fn state_file_path() -> Result<PathBuf, String> {
    let data_dir = account::get_data_dir()?;
    Ok(data_dir.join(STATE_FILE_NAME))
}

/// 递归收集某目录下所有 rollout-*.jsonl 文件
fn collect_rollout_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_rollout_files(&path, out);
        } else if file_type.is_file() {
            let is_rollout = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
                .unwrap_or(false);
            if is_rollout {
                out.push(path);
            }
        }
    }
}

/// 从 rollout 文件头部解析 session_meta（id / cwd）
fn read_rollout_session_meta(path: &Path) -> Option<(String, String)> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut read_total = 0usize;
    // session_meta 是 rollout 的第一条记录，读前几行即可
    for _ in 0..8 {
        line.clear();
        let n = reader.read_line(&mut line).ok()?;
        if n == 0 {
            break;
        }
        read_total += n;
        if read_total > META_READ_MAX_BYTES {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<JsonValue>(trimmed) else {
            continue;
        };
        if parsed.get("type").and_then(JsonValue::as_str) != Some("session_meta") {
            continue;
        }
        let payload = parsed.get("payload")?;
        let id = payload
            .get("id")
            .or_else(|| payload.get("session_id"))
            .and_then(JsonValue::as_str)?
            .trim()
            .to_string();
        if id.is_empty() {
            return None;
        }
        let cwd = payload
            .get("cwd")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        return Some((id, cwd));
    }
    None
}

/// 在默认 CODEX_HOME 中找出"最近活跃且很可能未完成"的会话
fn find_latest_active_session() -> Option<(String, String, PathBuf, i64)> {
    let codex_home = codex_account::get_codex_home();
    let mut candidates: Vec<PathBuf> = Vec::new();
    for dir_name in SESSION_DIRS {
        collect_rollout_files(&codex_home.join(dir_name), &mut candidates);
    }
    if candidates.is_empty() {
        return None;
    }

    let mut latest: Option<(PathBuf, i64)> = None;
    for path in candidates {
        let mtime = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        let Some(mtime) = mtime else {
            continue;
        };
        let is_newer = latest
            .as_ref()
            .map(|(_, latest_mtime)| mtime > *latest_mtime)
            .unwrap_or(true);
        if is_newer {
            latest = Some((path, mtime));
        }
    }

    let (path, mtime) = latest?;
    // 太久没动的会话不算"未完成"
    if now_unix() - mtime > ACTIVE_WINDOW_SECS {
        return None;
    }
    let (session_id, cwd) = read_rollout_session_meta(&path)?;
    Some((session_id, cwd, path, mtime))
}

/// 自动切号执行前调用：快照当前账号正在进行的会话
pub fn capture_before_auto_switch(target: &CodexAccount) {
    let Some(current) = codex_account::get_current_account() else {
        logger::log_info("[UnfinishedSession] 无当前账号，跳过未完成会话快照");
        return;
    };

    match find_latest_active_session() {
        Some((session_id, cwd, rollout_path, last_active_at)) => {
            logger::log_info(&format!(
                "[UnfinishedSession] 已快照未完成会话: session_id={}, from={}, to={}",
                session_id, current.email, target.email
            ));
            *lock_pending() = Some(PendingCapture {
                session_id,
                cwd,
                rollout_path: rollout_path.to_string_lossy().to_string(),
                last_active_at,
                from_account_id: current.id,
                from_email: current.email,
                captured_at: now_unix(),
            });
        }
        None => {
            logger::log_info("[UnfinishedSession] 未发现近期活跃会话，本次切号不记录");
            *lock_pending() = None;
        }
    }
}

/// 自动切号成功后调用：持久化未完成会话记录并通知前端 + 系统通知
pub fn finalize_after_auto_switch(app: &tauri::AppHandle, switched: &CodexAccount) {
    let pending = lock_pending().take();
    let Some(pending) = pending else {
        return;
    };

    let record = CodexUnfinishedSession {
        resume_command: format!("codex resume {}", pending.session_id),
        session_id: pending.session_id,
        cwd: pending.cwd,
        rollout_path: pending.rollout_path,
        last_active_at: pending.last_active_at,
        from_account_id: pending.from_account_id,
        from_email: pending.from_email,
        to_account_id: switched.id.clone(),
        to_email: switched.email.clone(),
        captured_at: pending.captured_at,
    };

    if let Err(err) = save_record(&record) {
        logger::log_warn(&format!("[UnfinishedSession] 写入状态文件失败: {}", err));
    }

    if let Err(err) = app.emit(EVENT_NAME, &record) {
        logger::log_warn(&format!("[UnfinishedSession] 事件发送失败: {}", err));
    }
    send_native_notification(&record);
}

/// 自动切号失败时调用：丢弃快照，避免残留过期记录
pub fn discard_pending() {
    *lock_pending() = None;
}

fn save_record(record: &CodexUnfinishedSession) -> Result<(), String> {
    let path = state_file_path()?;
    let content = serde_json::to_string_pretty(record)
        .map_err(|e| format!("序列化未完成会话记录失败: {}", e))?;
    crate::modules::atomic_write::write_string_atomic(&path, &content)
        .map_err(|e| format!("写入未完成会话状态文件失败: {}", e))
}

/// 读取当前未完成会话记录（前端查询用）
pub fn load_record() -> Option<CodexUnfinishedSession> {
    let path = state_file_path().ok()?;
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// 清除未完成会话记录（用户已继续/不再关心）
pub fn clear_record() -> Result<(), String> {
    let path = state_file_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除未完成会话状态文件失败: {}", e))?;
    }
    Ok(())
}

fn send_native_notification(record: &CodexUnfinishedSession) {
    let cwd_display = if record.cwd.is_empty() {
        "未知目录".to_string()
    } else {
        record.cwd.clone()
    };
    let body = format!(
        "已自动切换到 {}。上次未完成的会话位于 {}，回到 Codex 历史会话中继续即可。",
        record.to_email, cwd_display
    );
    if let Err(err) = app_handle_notification(&record, &body) {
        logger::log_warn(&format!("[UnfinishedSession] 系统通知发送失败: {}", err));
    }
}

fn app_handle_notification(
    _record: &CodexUnfinishedSession,
    body: &str,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let Some(app_handle) = crate::get_app_handle() else {
        return Err("应用句柄不可用".to_string());
    };
    app_handle
        .notification()
        .builder()
        .title("Codex 已自动换号")
        .body(body)
        .show()
        .map_err(|e| format!("{}", e))
}
