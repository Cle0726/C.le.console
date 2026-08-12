use crate::modules::atomic_write::{parse_json_with_auto_restore, write_string_atomic};
use crate::modules::{account, logger, process};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use sysinfo::{Pid, System};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{sleep, timeout, Duration};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const STATE_FILE: &str = "jimeng_api_service.json";
const RUNTIME_DIR: &str = "jimeng_api_service";
const DEFAULT_PORT: u16 = 15100;
const SIDECAR_VERSION: &str = "1.6.3-cle.1";
const WATCHDOG_INTERVAL_SECONDS: u64 = 10;
const WATCHDOG_FAILURE_THRESHOLD: u32 = 2;
const WATCHDOG_RESTART_COOLDOWN_SECONDS: u64 = 30;
const WATCHDOG_MAX_RESTART_COOLDOWN_SECONDS: u64 = 300;
static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);
static DEVICE_FLOWS: OnceLock<Mutex<HashMap<String, DeviceFlowSession>>> = OnceLock::new();
static ACCOUNT_HEALTH: OnceLock<Mutex<HashMap<String, AccountHealth>>> = OnceLock::new();

#[derive(Debug, Clone)]
struct DeviceFlowSession {
    flow_id: String,
    account_id: String,
    account_name: String,
    region: String,
    verification_uri: String,
    debug_port: u16,
    browser_pid: u32,
    expires_at: String,
    poll_interval: u64,
}

#[derive(Debug)]
struct DreaminaOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, Default)]
struct AccountHealth {
    consecutive_failures: u32,
    cooldown_until: i64,
    last_error: String,
}

#[derive(Debug, Default)]
struct JimengSelfHealRuntime {
    consecutive_failures: u32,
    restart_attempts: u32,
    restart_failures: u32,
    last_success_at: Option<String>,
    last_repair_at: Option<String>,
    next_restart_at: Option<String>,
    next_restart_after: Option<Instant>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpstreamErrorKind {
    Auth,
    Quota,
    Temporary,
    Request,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengAccount {
    pub id: String,
    pub name: String,
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(default = "default_auth_method")]
    pub auth_method: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub oauth_home: String,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengApiConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub debug_logs: bool,
    #[serde(default)]
    pub accounts: Vec<JimengAccount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengApiState {
    pub config: JimengApiConfig,
    pub running: bool,
    pub base_url: String,
    pub version: String,
    pub last_error: Option<String>,
    pub models: Vec<JimengModel>,
    pub self_heal: JimengSelfHealState,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JimengSelfHealState {
    pub status: String,
    pub consecutive_failures: u32,
    pub restart_attempts: u32,
    pub restart_failures: u32,
    pub last_success_at: Option<String>,
    pub last_repair_at: Option<String>,
    pub next_restart_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengModel {
    pub id: String,
    pub kind: String,
    pub regions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JimengMediaRequest {
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub image_paths: Vec<String>,
    #[serde(default)]
    pub video_paths: Vec<String>,
}

fn runtime_lifecycle() -> &'static AsyncMutex<()> {
    static RUNTIME_LIFECYCLE: OnceLock<AsyncMutex<()>> = OnceLock::new();
    RUNTIME_LIFECYCLE.get_or_init(|| AsyncMutex::new(()))
}

fn repair_lifecycle() -> &'static AsyncMutex<()> {
    static REPAIR_LIFECYCLE: OnceLock<AsyncMutex<()>> = OnceLock::new();
    REPAIR_LIFECYCLE.get_or_init(|| AsyncMutex::new(()))
}

fn self_heal_runtime() -> &'static AsyncMutex<JimengSelfHealRuntime> {
    static SELF_HEAL_RUNTIME: OnceLock<AsyncMutex<JimengSelfHealRuntime>> = OnceLock::new();
    SELF_HEAL_RUNTIME.get_or_init(|| AsyncMutex::new(JimengSelfHealRuntime::default()))
}

fn default_true() -> bool {
    true
}

fn default_auth_method() -> String {
    "session".into()
}

fn default_region() -> String {
    "cn".into()
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

fn default_config() -> JimengApiConfig {
    JimengApiConfig {
        enabled: false,
        port: DEFAULT_PORT,
        debug_logs: false,
        accounts: Vec::new(),
    }
}

fn data_dir() -> Result<PathBuf, String> {
    account::get_data_dir()
        .or_else(|_| account::resolve_data_dir())
        .map_err(|error| format!("解析即梦 API 数据目录失败: {error}"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(STATE_FILE))
}

fn runtime_dir() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(RUNTIME_DIR))
}

fn normalize_config(config: &mut JimengApiConfig) {
    if config.port == 0 {
        config.port = DEFAULT_PORT;
    }
    let mut account_ids = HashSet::new();
    for account in &mut config.accounts {
        account.id = account.id.trim().to_string();
        account.name = account.name.trim().to_string();
        account.region = normalize_region(&account.region);
        account.auth_method = match account.auth_method.trim() {
            "oauthDevice" => "oauthDevice".into(),
            _ => "session".into(),
        };
        account.session_id = account.session_id.trim().to_string();
        account.oauth_home = account.oauth_home.trim().to_string();
        account.proxy_url = account.proxy_url.trim().trim_end_matches('/').to_string();
        if account.id.is_empty() || !account_ids.insert(account.id.clone()) {
            account.id = uuid::Uuid::new_v4().to_string();
            account_ids.insert(account.id.clone());
        }
        if account.name.is_empty() {
            account.name = format!("即梦 {}", account.region.to_uppercase());
        }
    }
    config.accounts.retain(|account| {
        (account.auth_method == "session" && !account.session_id.is_empty())
            || (account.auth_method == "oauthDevice" && !account.oauth_home.is_empty())
    });
}

fn normalize_region(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "us" => "us".into(),
        "hk" => "hk".into(),
        "jp" => "jp".into(),
        "sg" => "sg".into(),
        _ => "cn".into(),
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn clean_wsl_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .replace('\0', "")
        .lines()
        .filter(|line| {
            let value = line.trim();
            !value.starts_with("wsl:")
                && !value.contains("Failed to translate")
                && !(value.contains("localhost") && value.len() < 180)
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn oauth_home_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>()
}

async fn run_dreamina(
    oauth_home: &str,
    args: &[String],
    timeout_seconds: u64,
) -> Result<DreaminaOutput, String> {
    if !cfg!(target_os = "windows") {
        return Err("即梦 OAuth Device Flow 当前仅在 Windows + WSL 环境启用".into());
    }
    let home_key = oauth_home_key(oauth_home);
    if home_key.is_empty() {
        return Err("OAuth 账号目录无效".into());
    }
    let encoded_args = args
        .iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "BASE_HOME=$(getent passwd \"$(id -u)\" | cut -d: -f6); \
         DREAMINA_BIN=$(command -v dreamina || find \"$BASE_HOME\" -maxdepth 4 -type f -name dreamina 2>/dev/null | head -n 1); \
         if [ -z \"$DREAMINA_BIN\" ]; then echo 'dreamina CLI not found' >&2; exit 127; fi; \
         export HOME=\"$BASE_HOME/.local/share/cle-console/jimeng-accounts/{home_key}\"; \
         export XDG_DATA_HOME=\"$HOME/.local/share\"; \
         export XDG_CONFIG_HOME=\"$HOME/.config\"; \
         mkdir -p \"$HOME\" \"$XDG_DATA_HOME\" \"$XDG_CONFIG_HOME\"; \
         cd /tmp; \"$DREAMINA_BIN\" {encoded_args}"
    );
    let mut command = TokioCommand::new(r"C:\Windows\System32\wsl.exe");
    command
        .args(["-e", "sh", "-lc", &script])
        .current_dir(r"C:\Windows")
        .env("PATH", r"C:\Windows\System32;C:\Windows")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(timeout_seconds), command.output())
        .await
        .map_err(|_| format!("dreamina CLI 执行超时（{timeout_seconds} 秒）"))?
        .map_err(|error| format!("启动 dreamina CLI 失败: {error}"))?;
    Ok(DreaminaOutput {
        success: output.status.success(),
        stdout: clean_wsl_output(&output.stdout),
        stderr: clean_wsl_output(&output.stderr),
    })
}

fn parse_device_material(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            let key = key.trim();
            if !matches!(
                key,
                "verification_uri" | "user_code" | "device_code" | "poll_interval" | "expires_at"
            ) {
                return None;
            }
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

fn flow_value(
    session: &DeviceFlowSession,
    status: &str,
    message: Option<String>,
    account: Option<&JimengAccount>,
) -> Value {
    json!({
        "flowId": session.flow_id,
        "accountId": session.account_id,
        "verificationUri": session.verification_uri,
        "userCode": "自动检测登录状态",
        "expiresAt": session.expires_at,
        "pollInterval": session.poll_interval,
        "status": status,
        "message": message,
        "account": account,
    })
}

fn device_flows() -> &'static Mutex<HashMap<String, DeviceFlowSession>> {
    DEVICE_FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn jimeng_login_url(region: &str) -> &'static str {
    if region == "cn" {
        "https://jimeng.jianying.com/ai-tool/home"
    } else {
        "https://dreamina.capcut.com/ai-tool/home"
    }
}

fn browser_executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(local).join(r"Google\Chrome\Application\chrome.exe"));
    }
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let root = PathBuf::from(program_files);
        candidates.push(root.join(r"Google\Chrome\Application\chrome.exe"));
        candidates.push(root.join(r"Microsoft\Edge\Application\msedge.exe"));
    }
    if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
        let root = PathBuf::from(program_files_x86);
        candidates.push(root.join(r"Google\Chrome\Application\chrome.exe"));
        candidates.push(root.join(r"Microsoft\Edge\Application\msedge.exe"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "未找到 Chrome 或 Microsoft Edge，无法启动即梦浏览器登录".to_string())
}

fn available_loopback_port() -> Result<u16, String> {
    TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("分配浏览器调试端口失败: {error}"))
}

fn stop_login_browser(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .status();
    }
}

fn cookie_matches_region(domain: &str, region: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    if region == "cn" {
        domain == "jianying.com" || domain.ends_with(".jianying.com")
    } else {
        domain == "capcut.com" || domain.ends_with(".capcut.com")
    }
}

fn select_session_cookie(cookies: &[Value], region: &str) -> Option<String> {
    ["sessionid", "sessionid_ss"]
        .into_iter()
        .find_map(|wanted| {
            cookies.iter().find_map(|cookie| {
                let name = cookie.get("name")?.as_str()?;
                let domain = cookie.get("domain")?.as_str()?;
                let value = cookie.get("value")?.as_str()?.trim();
                (name.eq_ignore_ascii_case(wanted)
                    && cookie_matches_region(domain, region)
                    && !value.is_empty())
                .then(|| value.to_string())
            })
        })
}

async fn fetch_browser_cookies(port: u16) -> Result<Vec<Value>, String> {
    let version = reqwest::get(format!("http://127.0.0.1:{port}/json/version"))
        .await
        .map_err(|error| format!("等待浏览器登录窗口启动: {error}"))?
        .error_for_status()
        .map_err(|error| format!("浏览器调试接口不可用: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("解析浏览器调试信息失败: {error}"))?;
    let ws_url = version
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "浏览器级调试连接尚未就绪".to_string())?;
    let (mut socket, _) = connect_async(ws_url)
        .await
        .map_err(|error| format!("连接浏览器登录状态失败: {error}"))?;
    socket
        .send(Message::Text(
            json!({"id": 1, "method": "Storage.getCookies", "params": {}})
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| format!("读取浏览器 Cookie 失败: {error}"))?;
    while let Some(message) = timeout(Duration::from_secs(3), socket.next())
        .await
        .map_err(|_| "读取浏览器登录状态超时".to_string())?
    {
        let message = message.map_err(|error| format!("浏览器登录连接中断: {error}"))?;
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            _ => continue,
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("解析浏览器 Cookie 响应失败: {error}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("浏览器拒绝读取登录状态: {error}"));
        }
        return Ok(value
            .pointer("/result/cookies")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default());
    }
    Err("浏览器登录页面已关闭".to_string())
}

async fn fetch_browser_authenticated(port: u16, region: &str) -> Result<bool, String> {
    let targets = reqwest::get(format!("http://127.0.0.1:{port}/json/list"))
        .await
        .map_err(|error| format!("读取即梦浏览器页面失败: {error}"))?
        .error_for_status()
        .map_err(|error| format!("即梦浏览器页面接口不可用: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("解析即梦浏览器页面失败: {error}"))?;
    let expected_host = if region == "cn" {
        "jimeng.jianying.com"
    } else {
        "dreamina.capcut.com"
    };
    let target = targets
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("type").and_then(Value::as_str) == Some("page")
                    && item
                        .get("url")
                        .and_then(Value::as_str)
                        .is_some_and(|url| url.contains(expected_host))
                    && item
                        .get("webSocketDebuggerUrl")
                        .and_then(Value::as_str)
                        .is_some()
            })
        })
        .ok_or_else(|| "等待即梦登录页加载完成".to_string())?;
    let ws_url = target
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "即梦登录页调试连接尚未就绪".to_string())?;
    let (mut socket, _) = connect_async(ws_url)
        .await
        .map_err(|error| format!("连接即梦登录页失败: {error}"))?;
    socket
        .send(Message::Text(
            json!({
                "id": 2,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": r#"(() => {
                      const identityKeys = new Set(['user_id', 'userId', 'uid', 'sec_user_id', 'account_id']);
                      const hasIdentity = (value, depth = 0) => {
                        if (!value || depth > 6) return false;
                        if (Array.isArray(value)) return value.some((item) => hasIdentity(item, depth + 1));
                        if (typeof value !== 'object') return false;
                        for (const [key, candidate] of Object.entries(value)) {
                          if (identityKeys.has(key) && ((typeof candidate === 'string' && candidate.trim()) || (typeof candidate === 'number' && candidate > 0))) return true;
                        }
                        return Object.values(value).some((item) => hasIdentity(item, depth + 1));
                      };
                      const parse = (value) => {
                        let current = value;
                        for (let attempt = 0; attempt < 2 && typeof current === 'string'; attempt += 1) {
                          try { current = JSON.parse(current); } catch { break; }
                        }
                        return current;
                      };
                      return window.__isLogined === true || [window.__userInfo, window.__userInfoStringify].some((value) => hasIdentity(parse(value)));
                    })()"#,
                    "returnByValue": true
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|error| format!("检查即梦登录状态失败: {error}"))?;
    while let Some(message) = timeout(Duration::from_secs(3), socket.next())
        .await
        .map_err(|_| "检查即梦登录状态超时".to_string())?
    {
        let message = message.map_err(|error| format!("即梦登录状态连接中断: {error}"))?;
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            _ => continue,
        };
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("解析即梦登录状态失败: {error}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(2) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(format!("即梦登录页拒绝状态检查: {error}"));
        }
        return Ok(value
            .pointer("/result/result/value")
            .and_then(Value::as_bool)
            .unwrap_or(false));
    }
    Ok(false)
}

async fn close_login_browser(debug_port: u16, pid: u32) {
    let graceful = async {
        let version = reqwest::get(format!("http://127.0.0.1:{debug_port}/json/version"))
            .await
            .ok()?
            .json::<Value>()
            .await
            .ok()?;
        let ws_url = version.get("webSocketDebuggerUrl")?.as_str()?;
        let (mut socket, _) = connect_async(ws_url).await.ok()?;
        socket
            .send(Message::Text(
                json!({"id": 3, "method": "Browser.close", "params": {}})
                    .to_string()
                    .into(),
            ))
            .await
            .ok()?;
        Some(())
    };
    let _ = graceful.await;
    sleep(Duration::from_millis(1_200)).await;
    stop_login_browser(pid);
}

pub async fn start_device_flow(
    account_id: String,
    account_name: String,
    region: String,
) -> Result<Value, String> {
    let account_id = if account_id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        account_id.trim().to_string()
    };
    let account_name = if account_name.trim().is_empty() {
        "即梦浏览器账号".into()
    } else {
        account_name.trim().to_string()
    };
    let region = normalize_region(&region);
    let verification_uri = jimeng_login_url(&region).to_string();
    let debug_port = available_loopback_port()?;
    // Account IDs, unlike display names, are unique. This prevents two
    // same-region accounts with the same label from sharing browser state.
    let profile_digest = md5::compute(format!("{region}:{account_id}"));
    let profile_key = format!("{}-{:x}", region, profile_digest);
    let profile_root = runtime_dir()?.join("browser-profiles");
    let mut profile_dir = profile_root.join(profile_key);
    // Builds before the account-id isolation fix keyed profiles by display
    // name. Reuse that profile once for existing accounts so a verified login
    // is not discarded during upgrade. New accounts always stay ID-isolated.
    let is_existing_account = load_config()
        .ok()
        .is_some_and(|config| config.accounts.iter().any(|item| item.id == account_id));
    if is_existing_account && !profile_dir.is_dir() {
        let legacy_digest = md5::compute(format!("{region}:{account_name}"));
        let legacy_dir = profile_root.join(format!("{}-{:x}", region, legacy_digest));
        if legacy_dir.is_dir() {
            profile_dir = legacy_dir;
        }
    }
    std::fs::create_dir_all(&profile_dir)
        .map_err(|error| format!("创建即梦浏览器登录目录失败: {error}"))?;
    let browser = browser_executable()?;
    let mut command = Command::new(&browser);
    command
        .arg(format!("--remote-debugging-port={debug_port}"))
        .arg("--remote-allow-origins=*")
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--new-window")
        .arg(&verification_uri)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let child = command
        .spawn()
        .map_err(|error| format!("启动 {} 失败: {error}", browser.display()))?;
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(60)).to_rfc3339();
    let session = DeviceFlowSession {
        flow_id: uuid::Uuid::new_v4().to_string(),
        account_id,
        account_name,
        region,
        verification_uri,
        debug_port,
        browser_pid: child.id(),
        expires_at,
        poll_interval: 2,
    };
    device_flows()
        .lock()
        .map_err(|_| "OAuth 会话锁已损坏")?
        .insert(session.flow_id.clone(), session.clone());
    Ok(flow_value(
        &session,
        "pending",
        Some("请在专用浏览器窗口登录即梦；登录成功后 C.le. 会自动识别并保存账号".into()),
        None,
    ))
}

pub async fn poll_device_flow(flow_id: &str) -> Result<Value, String> {
    let session = device_flows()
        .lock()
        .map_err(|_| "OAuth 会话锁已损坏")?
        .get(flow_id)
        .cloned()
        .ok_or("OAuth 会话不存在或已经结束")?;
    if chrono::DateTime::parse_from_rfc3339(&session.expires_at)
        .map(|expires| expires < chrono::Utc::now())
        .unwrap_or(false)
    {
        stop_login_browser(session.browser_pid);
        device_flows()
            .lock()
            .map_err(|_| "浏览器登录会话锁已损坏")?
            .remove(flow_id);
        return Ok(flow_value(
            &session,
            "expired",
            Some("浏览器登录等待已超时，请重新发起登录".into()),
            None,
        ));
    }
    match fetch_browser_authenticated(session.debug_port, &session.region).await {
        Ok(false) => {
            return Ok(flow_value(
                &session,
                "pending",
                Some(
                    "浏览器已连接，等待即梦账号真正登录完成；不会再把匿名 Cookie 误判为成功".into(),
                ),
                None,
            ));
        }
        Err(error) => {
            return Ok(flow_value(&session, "pending", Some(error), None));
        }
        Ok(true) => {
            // The web client automatically performs its daily-credit sync
            // immediately after login. Give it enough time to finish before
            // persisting cookies and closing the isolated browser.
            sleep(Duration::from_millis(2_500)).await;
            if !fetch_browser_authenticated(session.debug_port, &session.region)
                .await
                .unwrap_or(false)
            {
                return Ok(flow_value(
                    &session,
                    "pending",
                    Some("检测到登录状态仍在同步，请稍候".into()),
                    None,
                ));
            }
        }
    }
    match fetch_browser_cookies(session.debug_port).await {
        Ok(cookies) => {
            let cookie_names = cookies
                .iter()
                .filter_map(|cookie| {
                    let domain = cookie.get("domain")?.as_str()?;
                    if !cookie_matches_region(domain, &session.region) {
                        return None;
                    }
                    cookie.get("name")?.as_str().map(str::to_string)
                })
                .collect::<Vec<_>>();
            logger::log_info(&format!(
                "[JimengAPI] browser login poll: flow={}, region={}, matching_cookies={}, names={}",
                session.flow_id,
                session.region,
                cookie_names.len(),
                cookie_names.join(",")
            ));
            let Some(session_id) = select_session_cookie(&cookies, &session.region) else {
                return Ok(flow_value(
                    &session,
                    "pending",
                    Some("已连接浏览器，等待即梦登录完成…".into()),
                    None,
                ));
            };
            let mut config = load_config()?;
            let account = JimengAccount {
                id: session.account_id.clone(),
                name: session.account_name.clone(),
                region: session.region.clone(),
                auth_method: "session".into(),
                session_id,
                oauth_home: String::new(),
                proxy_url: String::new(),
                priority: 0,
                enabled: true,
            };
            if config.enabled {
                if let Err(error) = start_runtime(&config).await {
                    return Ok(flow_value(
                        &session,
                        "pending",
                        Some(format!("登录已完成，等待即梦 API 服务恢复后验证: {error}")),
                        None,
                    ));
                }
                if let Err(error) = validate_session_account(&config, &account).await {
                    return Ok(flow_value(
                        &session,
                        "pending",
                        Some(format!("浏览器登录已识别，但 API 登录态尚未同步: {error}")),
                        None,
                    ));
                }
            }
            if let Some(existing) = config
                .accounts
                .iter_mut()
                .find(|item| item.id == account.id)
            {
                *existing = account.clone();
            } else {
                config.accounts.push(account.clone());
            }
            normalize_config(&mut config);
            save_config_file(&config)?;
            let browser_retained = session.region != "cn";
            if !browser_retained {
                close_login_browser(session.debug_port, session.browser_pid).await;
            }
            device_flows()
                .lock()
                .map_err(|_| "浏览器登录会话锁已损坏")?
                .remove(flow_id);
            Ok(flow_value(
                &session,
                "authorized",
                Some(if browser_retained {
                    "浏览器登录成功，Session ID 已安全保存；专用浏览器已保留，请在 Dreamina 页面完成每日积分验证/领取后自行关闭窗口".into()
                } else {
                    "浏览器登录成功，Session ID 已安全保存并加入账号池".into()
                }),
                Some(&account),
            ))
        }
        Err(error) => Ok(flow_value(&session, "pending", Some(error), None)),
    }
}

pub fn cancel_device_flow(flow_id: &str) -> Result<(), String> {
    if let Some(session) = device_flows()
        .lock()
        .map_err(|_| "浏览器登录会话锁已损坏")?
        .remove(flow_id)
    {
        stop_login_browser(session.browser_pid);
    }
    Ok(())
}

fn load_config() -> Result<JimengApiConfig, String> {
    let path = state_path()?;
    if !path.exists() {
        let config = default_config();
        save_config_file(&config)?;
        return Ok(config);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("读取即梦 API 配置失败: {error}"))?;
    let mut config: JimengApiConfig = parse_json_with_auto_restore(&path, &raw)
        .map_err(|error| format!("解析即梦 API 配置失败: {error}"))?;
    normalize_config(&mut config);
    Ok(config)
}

fn save_config_file(config: &JimengApiConfig) -> Result<(), String> {
    let path = state_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建即梦 API 配置目录失败: {error}"))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化即梦 API 配置失败: {error}"))?;
    write_string_atomic(&path, &raw)
}

fn model_catalog() -> Vec<JimengModel> {
    let rows = [
        ("jimeng-5.0", "image", "cn,hk,jp,sg"),
        ("jimeng-4.6", "image", "cn,hk,jp,sg"),
        ("jimeng-4.5", "image", "cn,us,hk,jp,sg"),
        ("jimeng-4.1", "image", "cn,us,hk,jp,sg"),
        ("jimeng-4.0", "image", "cn,us,hk,jp,sg"),
        ("jimeng-3.1", "image", "cn"),
        ("jimeng-3.0", "image", "cn,us,hk,jp,sg"),
        ("nanobanana", "image", "us,hk,jp,sg"),
        ("nanobananapro", "image", "us,hk,jp,sg"),
        ("jimeng-video-seedance-2.0", "video", "cn"),
        ("jimeng-video-seedance-2.0-fast", "video", "cn"),
        ("jimeng-video-3.5-pro", "video", "cn,us,hk,jp,sg"),
        ("jimeng-video-veo3", "video", "hk,jp,sg"),
        ("jimeng-video-veo3.1", "video", "hk,jp,sg"),
        ("jimeng-video-sora2", "video", "hk,jp,sg"),
        ("jimeng-video-3.0-pro", "video", "cn,hk,jp,sg"),
        ("jimeng-video-3.0", "video", "cn,us,hk,jp,sg"),
        ("jimeng-video-3.0-fast", "video", "cn,hk,jp,sg"),
        ("jimeng-video-2.0-pro", "video", "cn,hk,jp,sg"),
        ("jimeng-video-2.0", "video", "cn,hk,jp,sg"),
    ];
    rows.into_iter()
        .map(|(id, kind, regions)| JimengModel {
            id: id.into(),
            kind: kind.into(),
            regions: regions.split(',').map(str::to_string).collect(),
        })
        .collect()
}

fn token_for_account(account: &JimengAccount) -> String {
    let token = match account.region.as_str() {
        "us" => format!("us-{}", account.session_id.trim_start_matches("us-")),
        "hk" => format!("hk-{}", account.session_id.trim_start_matches("hk-")),
        "jp" => format!("jp-{}", account.session_id.trim_start_matches("jp-")),
        "sg" => format!("sg-{}", account.session_id.trim_start_matches("sg-")),
        _ => account.session_id.to_string(),
    };
    if account.proxy_url.is_empty() {
        token
    } else {
        format!("{}@{}", account.proxy_url, token)
    }
}

fn account_candidates<'a>(
    config: &'a JimengApiConfig,
    account_id: Option<&str>,
) -> Vec<&'a JimengAccount> {
    let mut accounts: Vec<_> = config
        .accounts
        .iter()
        .filter(|account| account.enabled)
        .filter(|account| account_id.map(|id| id == account.id).unwrap_or(true))
        .collect();
    accounts.sort_by_key(|account| -account.priority);
    accounts
}

fn account_health() -> &'static Mutex<HashMap<String, AccountHealth>> {
    ACCOUNT_HEALTH.get_or_init(|| Mutex::new(HashMap::new()))
}

fn classify_upstream_error(error: &str) -> UpstreamErrorKind {
    let value = error.to_ascii_lowercase();
    if value.contains("http 401")
        || value.contains("http 403")
        || value.contains("unauthorized")
        || value.contains("forbidden")
        || value.contains("invalid token")
        || value.contains("session expired")
        || value.contains("browser identity missing")
        || value.contains("requiresbrowserlogin")
        || value.contains("login error")
        || value.contains("网页登录态")
        || value.contains("重新完成浏览器登录")
    {
        UpstreamErrorKind::Auth
    } else if value.contains("http 429")
        || value.contains("quota")
        || value.contains("insufficient")
        || value.contains("too many requests")
        || value.contains("额度")
        || value.contains("限流")
    {
        UpstreamErrorKind::Quota
    } else if value.contains("http 500")
        || value.contains("http 502")
        || value.contains("http 503")
        || value.contains("http 504")
        || value.contains("timeout")
        || value.contains("timed out")
        || value.contains("connection")
        || value.contains("temporarily")
    {
        UpstreamErrorKind::Temporary
    } else {
        UpstreamErrorKind::Request
    }
}

fn account_cooldown_remaining(account_id: &str) -> u64 {
    let now = chrono::Utc::now().timestamp();
    account_health()
        .lock()
        .ok()
        .and_then(|health| health.get(account_id).cloned())
        .map(|health| health.cooldown_until.saturating_sub(now) as u64)
        .unwrap_or_default()
}

fn record_account_success(account_id: &str) {
    if let Ok(mut health) = account_health().lock() {
        health.remove(account_id);
    }
}

fn record_account_failure(account_id: &str, error: &str) -> UpstreamErrorKind {
    let kind = classify_upstream_error(error);
    if kind == UpstreamErrorKind::Request {
        return kind;
    }
    if let Ok(mut states) = account_health().lock() {
        let state = states.entry(account_id.to_string()).or_default();
        state.consecutive_failures = state.consecutive_failures.saturating_add(1);
        let seconds = match kind {
            UpstreamErrorKind::Auth => 10 * 60,
            UpstreamErrorKind::Quota => 2 * 60,
            UpstreamErrorKind::Temporary => 2u64
                .saturating_pow(state.consecutive_failures.min(6))
                .min(60),
            UpstreamErrorKind::Request => 0,
        };
        state.cooldown_until = chrono::Utc::now().timestamp() + seconds as i64;
        state.last_error = error.chars().take(500).collect();
    }
    kind
}

fn model_supports_region(model_id: &str, region: &str) -> bool {
    model_catalog()
        .into_iter()
        .find(|model| model.id == model_id)
        .map(|model| model.regions.iter().any(|candidate| candidate == region))
        .unwrap_or(true)
}

fn write_runtime_config(config: &JimengApiConfig) -> Result<PathBuf, String> {
    let root = runtime_dir()?;
    let config_dir = root.join("configs").join("dev");
    std::fs::create_dir_all(&config_dir)
        .map_err(|error| format!("创建即梦运行目录失败: {error}"))?;
    std::fs::create_dir_all(root.join("logs"))
        .map_err(|error| format!("创建即梦日志目录失败: {error}"))?;
    std::fs::create_dir_all(root.join("tmp"))
        .map_err(|error| format!("创建即梦临时目录失败: {error}"))?;
    let service = format!(
        "name: jimeng-api\nhost: '127.0.0.1'\nport: {}\n",
        config.port
    );
    let system = format!(
        "requestLog: {}\ndebug: {}\nlog_level: {}\ntmpDir: ./tmp\nlogDir: ./logs\nlogWriteInterval: 200\nlogFileExpires: 2626560000\ntmpFileExpires: 86400000\n",
        config.debug_logs,
        config.debug_logs,
        if config.debug_logs { "debug" } else { "info" },
    );
    write_string_atomic(&config_dir.join("service.yml"), &service)?;
    write_string_atomic(&config_dir.join("system.yml"), &system)?;
    write_string_atomic(
        &root.join("package.json"),
        r#"{"name":"jimeng-api","version":"1.6.3","type":"commonjs"}"#,
    )?;
    Ok(root)
}

fn binary_file_names() -> Vec<String> {
    let target = env!("CLE_RUST_TARGET");
    if cfg!(target_os = "windows") {
        vec![format!("jimeng-api-{target}.exe"), "jimeng-api.exe".into()]
    } else {
        vec![format!("jimeng-api-{target}"), "jimeng-api".into()]
    }
}

fn push_binary_candidates(candidates: &mut Vec<PathBuf>, dir: &Path) {
    for name in binary_file_names() {
        let path = dir.join(name);
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
}

fn binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("读取程序路径失败: {error}"))?;
    let parent = exe.parent().ok_or("程序路径没有父目录")?;
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_dir = manifest_dir.join("../sidecars/jimeng-api/bin");
    let mut candidates = Vec::new();
    if cfg!(debug_assertions) {
        push_binary_candidates(&mut candidates, &dev_dir);
    }
    push_binary_candidates(&mut candidates, parent);
    if let Some(contents_dir) = parent.parent() {
        push_binary_candidates(&mut candidates, &contents_dir.join("Resources"));
    }
    if !cfg!(debug_assertions) {
        push_binary_candidates(&mut candidates, &dev_dir);
    }
    candidates
        .iter()
        .find(|path| path.is_file())
        .cloned()
        .ok_or_else(|| {
            format!(
                "未找到即梦 API sidecar，已检查: {}",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

fn log_file(root: &Path, name: &str) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("logs").join(name))
        .map_err(|error| format!("打开即梦日志失败: {error}"))
}

fn normalized_executable_path(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = resolved.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        return value.trim_start_matches("//?/").to_ascii_lowercase();
    }
    #[cfg(not(target_os = "windows"))]
    value
}

fn terminate_owned_sidecar_from_pid_file() -> Result<bool, String> {
    let pid_path = runtime_dir()?.join("sidecar.pid");
    let pid_text = match std::fs::read_to_string(&pid_path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取即梦 sidecar PID 失败: {error}")),
    };
    let pid = pid_text
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("即梦 sidecar PID 文件无效: {error}"))?;
    if !process::is_pid_running(pid) {
        let _ = std::fs::remove_file(pid_path);
        return Ok(false);
    }

    let binary = binary_path()?;
    let system = System::new_all();
    let running = system
        .process(Pid::from(pid as usize))
        .ok_or_else(|| format!("即梦 sidecar PID {pid} 已失效"))?;
    let executable = running
        .exe()
        .ok_or_else(|| format!("无法验证即梦 sidecar PID {pid} 的可执行文件"))?;
    if normalized_executable_path(executable) != normalized_executable_path(&binary) {
        return Err(format!(
            "PID {pid} 的可执行文件与即梦 sidecar 不匹配，拒绝结束进程"
        ));
    }
    if !running.kill() {
        return Err(format!("结束失去响应的即梦 sidecar PID {pid} 失败"));
    }
    logger::log_warn(&format!(
        "[JimengAPI] terminated unresponsive owned sidecar PID {pid}"
    ));
    Ok(true)
}

async fn wait_for_runtime_port_release(port: u16) -> Result<(), String> {
    for _ in 0..50 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            if let Ok(root) = runtime_dir() {
                let _ = std::fs::remove_file(root.join("sidecar.pid"));
            }
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
    }
    Err("?? API sidecar ??????".into())
}

async fn probe(port: u16) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(900))
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| format!("创建即梦健康检查客户端失败: {error}"))?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/"))
        .send()
        .await
        .map_err(|error| format!("即梦服务未响应: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("即梦健康响应无效: {error}"))?;
    if !status.is_success() || value.get("service").and_then(Value::as_str) != Some("jimeng-api") {
        return Err("端口上的服务不是 jimeng-api".into());
    }
    Ok(value)
}

async fn probe_models(port: u16) -> Result<usize, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(900))
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| format!("创建即梦模型检查客户端失败: {error}"))?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/v1/models"))
        .send()
        .await
        .map_err(|error| format!("即梦模型接口未响应: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("即梦模型接口返回 HTTP {}", response.status()));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("即梦模型响应无效: {error}"))?;
    let count = value
        .get("data")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    if count < model_catalog().len() {
        return Err(format!("模型目录不完整: {count}"));
    }
    Ok(count)
}

async fn probe_runtime_contract(port: u16) -> Result<(Value, usize), String> {
    let (health, models) = tokio::join!(probe(port), probe_models(port));
    Ok((health?, models?))
}

fn watchdog_restart_delay(restart_failures: u32) -> Duration {
    let exponent = restart_failures.min(4);
    let seconds = WATCHDOG_RESTART_COOLDOWN_SECONDS
        .saturating_mul(1_u64 << exponent)
        .min(WATCHDOG_MAX_RESTART_COOLDOWN_SECONDS);
    Duration::from_secs(seconds)
}

async fn self_heal_snapshot() -> JimengSelfHealState {
    let state = self_heal_runtime().lock().await;
    let status = if state.consecutive_failures == 0 {
        if state.last_success_at.is_some() {
            "healthy"
        } else {
            "idle"
        }
    } else if state.next_restart_after.is_some() {
        "recovering"
    } else {
        "degraded"
    };
    JimengSelfHealState {
        status: status.to_string(),
        consecutive_failures: state.consecutive_failures,
        restart_attempts: state.restart_attempts,
        restart_failures: state.restart_failures,
        last_success_at: state.last_success_at.clone(),
        last_repair_at: state.last_repair_at.clone(),
        next_restart_at: state.next_restart_at.clone(),
        last_error: state.last_error.clone(),
    }
}

async fn record_health_success(repaired: bool) {
    let mut state = self_heal_runtime().lock().await;
    state.consecutive_failures = 0;
    state.restart_failures = 0;
    state.next_restart_after = None;
    state.next_restart_at = None;
    state.last_error = None;
    state.last_success_at = Some(chrono::Utc::now().to_rfc3339());
    if repaired {
        state.last_repair_at = state.last_success_at.clone();
    }
}

async fn record_health_failure(error: impl Into<String>) -> u32 {
    let mut state = self_heal_runtime().lock().await;
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    state.last_error = Some(error.into());
    state.consecutive_failures
}

async fn observe_health_failure(error: impl Into<String>) {
    let mut state = self_heal_runtime().lock().await;
    state.consecutive_failures = state.consecutive_failures.max(1);
    state.last_error = Some(error.into());
}

async fn record_restart_failure(error: String) {
    let mut state = self_heal_runtime().lock().await;
    state.restart_failures = state.restart_failures.saturating_add(1);
    state.last_error = Some(error);
    let delay = watchdog_restart_delay(state.restart_failures);
    state.next_restart_after = Some(Instant::now() + delay);
    state.next_restart_at =
        Some((chrono::Utc::now() + chrono::Duration::seconds(delay.as_secs() as i64)).to_rfc3339());
}

async fn start_runtime_locked(config: &JimengApiConfig) -> Result<(), String> {
    if probe_runtime_contract(config.port).await.is_ok() {
        return Ok(());
    }
    if probe(config.port).await.is_ok() {
        logger::log_warn(
            "[JimengAPI] sidecar identity is valid but its API contract is degraded; restarting",
        );
        stop_runtime_locked(config).await?;
    }
    if tokio::net::TcpStream::connect(("127.0.0.1", config.port))
        .await
        .is_ok()
    {
        return Err(format!("端口 {} 已被其他程序占用", config.port));
    }
    let root = write_runtime_config(config)?;
    let binary = binary_path()?;
    let stdout = log_file(&root, "stdout.log")?;
    let stderr = log_file(&root, "stderr.log")?;
    let mut command = Command::new(binary);
    command
        .current_dir(&root)
        .env("NODE_ENV", "dev")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0208);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动即梦 API sidecar 失败: {error}"))?;
    write_string_atomic(&root.join("sidecar.pid"), &child.id().to_string())?;
    let startup_deadline = Instant::now() + Duration::from_secs(18);
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("检查即梦进程失败: {error}"))?
        {
            return Err(format!("即梦 API sidecar 提前退出: {status}"));
        }
        if timeout(
            Duration::from_millis(1_200),
            probe_runtime_contract(config.port),
        )
        .await
        .is_ok_and(|result| result.is_ok())
        {
            logger::log_info(&format!(
                "[JimengAPI] sidecar ready: http://127.0.0.1:{}",
                config.port
            ));
            return Ok(());
        }
        if Instant::now() >= startup_deadline {
            break;
        }
        sleep(Duration::from_millis(150)).await;
    }
    let _ = child.kill();
    Err("即梦 API sidecar 启动超时".into())
}

async fn stop_runtime_locked(config: &JimengApiConfig) -> Result<(), String> {
    if probe(config.port).await.is_err() {
        if tokio::net::TcpStream::connect(("127.0.0.1", config.port))
            .await
            .is_err()
        {
            return Ok(());
        }
        if terminate_owned_sidecar_from_pid_file()? {
            return wait_for_runtime_port_release(config.port).await;
        }
        return Err(format!("?? {} ???????????? sidecar?????????", config.port));
    }
    process::kill_port_processes(config.port)
        .map_err(|error| format!("???? API sidecar ??: {error}"))?;
    wait_for_runtime_port_release(config.port).await
}

async fn start_runtime(config: &JimengApiConfig) -> Result<(), String> {
    let _guard = runtime_lifecycle().lock().await;
    start_runtime_locked(config).await
}

async fn stop_runtime(config: &JimengApiConfig) -> Result<(), String> {
    let _guard = runtime_lifecycle().lock().await;
    stop_runtime_locked(config).await
}

async fn restart_runtime(config: &JimengApiConfig) -> Result<(), String> {
    let _guard = runtime_lifecycle().lock().await;
    stop_runtime_locked(config).await?;
    start_runtime_locked(config).await
}

pub async fn get_state() -> Result<JimengApiState, String> {
    let config = load_config()?;
    let contract = probe_runtime_contract(config.port).await;
    if config.enabled {
        match contract.as_ref() {
            Ok(_) => record_health_success(false).await,
            Err(error) => observe_health_failure(error.clone()).await,
        }
    }
    let mut self_heal = self_heal_snapshot().await;
    if !config.enabled {
        self_heal.status = "idle".to_string();
    }
    Ok(JimengApiState {
        running: contract.is_ok(),
        base_url: format!("http://127.0.0.1:{}/v1", config.port),
        version: contract
            .as_ref()
            .ok()
            .and_then(|(value, _)| value.get("version"))
            .and_then(Value::as_str)
            .unwrap_or(SIDECAR_VERSION)
            .to_string(),
        last_error: contract.err(),
        models: model_catalog(),
        self_heal,
        config,
    })
}

pub async fn save_config(mut config: JimengApiConfig) -> Result<JimengApiState, String> {
    normalize_config(&mut config);
    let previous = load_config().unwrap_or_else(|_| default_config());
    save_config_file(&config)?;
    if previous.enabled && previous.port != config.port {
        let _ = stop_runtime(&previous).await;
    }
    if config.enabled {
        start_runtime(&config).await?;
    } else {
        let _ = stop_runtime(&previous).await;
    }
    get_state().await
}

pub async fn set_enabled(enabled: bool) -> Result<JimengApiState, String> {
    let mut config = load_config()?;
    config.enabled = enabled;
    save_config_file(&config)?;
    if enabled {
        start_runtime(&config).await?;
    } else {
        stop_runtime(&config).await?;
    }
    get_state().await
}

pub async fn restore() {
    match load_config() {
        Ok(config) if config.enabled => {
            if let Err(error) = start_runtime(&config).await {
                logger::log_warn(&format!("[JimengAPI] restore failed: {error}"));
            }
        }
        Ok(_) => {}
        Err(error) => logger::log_warn(&format!("[JimengAPI] config load failed: {error}")),
    }
    start_watchdog();
}

fn start_watchdog() {
    if WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        loop {
            sleep(Duration::from_secs(WATCHDOG_INTERVAL_SECONDS)).await;
            let config = match load_config() {
                Ok(config) if config.enabled => config,
                Ok(_) => continue,
                Err(error) => {
                    logger::log_warn(&format!(
                        "[JimengAPI][watchdog] config load failed; waiting for next repair cycle: {error}"
                    ));
                    continue;
                }
            };
            let probe_error = match probe_runtime_contract(config.port).await {
                Ok(_) => {
                    record_health_success(false).await;
                    continue;
                }
                Err(error) => error,
            };
            let consecutive_failures = record_health_failure(probe_error.clone()).await;
            logger::log_warn(&format!(
                "[JimengAPI][watchdog] contract probe failed {consecutive_failures}/{WATCHDOG_FAILURE_THRESHOLD}: {probe_error}"
            ));
            if consecutive_failures < WATCHDOG_FAILURE_THRESHOLD {
                continue;
            }

            let should_restart = {
                let mut state = self_heal_runtime().lock().await;
                if state
                    .next_restart_after
                    .is_some_and(|deadline| deadline > Instant::now())
                {
                    false
                } else {
                    let delay = watchdog_restart_delay(state.restart_failures);
                    state.restart_attempts = state.restart_attempts.saturating_add(1);
                    state.next_restart_after = Some(Instant::now() + delay);
                    state.next_restart_at = Some(
                        (chrono::Utc::now() + chrono::Duration::seconds(delay.as_secs() as i64))
                            .to_rfc3339(),
                    );
                    true
                }
            };
            if !should_restart {
                continue;
            }

            let _repair_guard = repair_lifecycle().lock().await;
            logger::log_warn(
                "[JimengAPI][watchdog] repeated contract failure; serially recovering sidecar",
            );
            match restart_runtime(&config).await {
                Ok(()) => match probe_runtime_contract(config.port).await {
                    Ok(_) => {
                        record_health_success(true).await;
                        logger::log_info(
                            "[JimengAPI][watchdog] sidecar recovered and full API contract verified",
                        );
                    }
                    Err(error) => {
                        logger::log_warn(&format!(
                            "[JimengAPI][watchdog] restart completed but contract is still degraded: {error}"
                        ));
                        record_restart_failure(error).await;
                    }
                },
                Err(error) => {
                    logger::log_warn(&format!(
                        "[JimengAPI][watchdog] automatic recovery failed: {error}"
                    ));
                    record_restart_failure(error).await;
                }
            }
        }
    });
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(35 * 60))
        .build()
        .map_err(|error| format!("创建即梦请求客户端失败: {error}"))
}

async fn response_value(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取即梦响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            text.replace(['\r', '\n'], " ")
                .chars()
                .take(800)
                .collect::<String>()
        ));
    }
    serde_json::from_str(&text).or_else(|_| Ok(json!({ "data": text })))
}

async fn validate_session_account(
    config: &JimengApiConfig,
    account: &JimengAccount,
) -> Result<Value, String> {
    let client = http_client()?;
    let token = token_for_account(account);
    let check = client
        .post(format!("http://127.0.0.1:{}/token/check", config.port))
        .json(&json!({ "token": token }))
        .send()
        .await
        .map_err(|error| format!("检查即梦登录态失败: {error}"))?;
    let check = response_value(check).await?;
    if check.get("live").and_then(Value::as_bool) != Some(true) {
        return Err("即梦网页身份校验未通过，请继续在专用浏览器中完成登录".into());
    }
    let response = client
        .post(format!("http://127.0.0.1:{}/token/points", config.port))
        .bearer_auth(token_for_account(account))
        .json(&json!({}))
        .send()
        .await
        .map_err(|error| format!("验证即梦登录态失败: {error}"))?;
    let value = response_value(response).await?;
    let valid = value.as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item.get("points").and_then(Value::as_object).is_some())
    });
    if valid {
        Ok(value)
    } else {
        Err("即梦积分接口未确认登录态，请在浏览器中完成登录后再等待数秒".into())
    }
}

fn add_payload_text(
    mut form: reqwest::multipart::Form,
    payload: &Value,
) -> reqwest::multipart::Form {
    if let Some(object) = payload.as_object() {
        for (key, value) in object {
            if value.is_null() {
                continue;
            }
            let text = value
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| value.to_string());
            form = form.text(key.clone(), text);
        }
    }
    form
}

fn add_file(
    form: reqwest::multipart::Form,
    field: String,
    path: &str,
) -> Result<reqwest::multipart::Form, String> {
    let file_path = PathBuf::from(path);
    let bytes = std::fs::read(&file_path)
        .map_err(|error| format!("读取素材失败 {}: {error}", file_path.display()))?;
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("upload.bin")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes).file_name(file_name);
    Ok(form.part(field, part))
}

fn windows_path_to_wsl(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() > 2 && bytes[1] == b':' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        return format!("/mnt/{drive}/{}", normalized[3..].trim_start_matches('/'));
    }
    normalized
}

fn payload_string(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn payload_integer(payload: &Value, key: &str, fallback: i64) -> i64 {
    payload
        .get(key)
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(fallback)
}

fn cli_image_model(model: &str) -> String {
    model
        .trim_start_matches("jimeng-")
        .trim_end_matches("-pro")
        .to_string()
}

fn cli_video_model(model: &str) -> Option<String> {
    match model {
        "jimeng-video-seedance-2.0" => Some("seedance2.0".into()),
        "jimeng-video-seedance-2.0-fast" => Some("seedance2.0fast".into()),
        _ => None,
    }
}

fn parse_cli_json(text: &str) -> Value {
    for (index, character) in text.char_indices() {
        if character != '{' && character != '[' {
            continue;
        }
        let mut stream = serde_json::Deserializer::from_str(&text[index..]).into_iter::<Value>();
        if let Some(Ok(value)) = stream.next() {
            return value;
        }
    }
    json!({ "text": text })
}

fn collect_media_urls(value: &Value, urls: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            for (key, item) in object {
                if let Some(url) = item.as_str() {
                    let lower = key.to_ascii_lowercase();
                    if (lower.contains("url") || lower.contains("image") || lower.contains("video"))
                        && (url.starts_with("http://")
                            || url.starts_with("https://")
                            || url.starts_with("data:image/"))
                        && !urls.iter().any(|existing| existing == url)
                    {
                        urls.push(url.to_string());
                    }
                }
                collect_media_urls(item, urls);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_media_urls(item, urls);
            }
        }
        _ => {}
    }
}

fn oauth_supports_request(account: &JimengAccount, endpoint: &str, model: &str) -> bool {
    if account.auth_method != "oauthDevice" || account.region != "cn" {
        return false;
    }
    if endpoint.starts_with("/v1/images/") {
        return model.starts_with("jimeng-") && !model.starts_with("jimeng-video-");
    }
    cli_video_model(model).is_some()
}

async fn send_oauth_media_once(
    account: &JimengAccount,
    endpoint: &str,
    request: &JimengMediaRequest,
) -> Result<Value, String> {
    let prompt = payload_string(&request.payload, "prompt").ok_or("生成提示词不能为空")?;
    let model = payload_string(&request.payload, "model").unwrap_or_default();
    let mut args = Vec::<String>::new();
    if endpoint.starts_with("/v1/images/") {
        args.push(if request.image_paths.is_empty() {
            "text2image".into()
        } else {
            "image2image".into()
        });
        args.push(format!("--prompt={prompt}"));
        if !model.is_empty() {
            args.push(format!("--model_version={}", cli_image_model(&model)));
        }
        if let Some(ratio) = payload_string(&request.payload, "ratio") {
            args.push(format!("--ratio={ratio}"));
        }
        if let Some(resolution) = payload_string(&request.payload, "resolution") {
            args.push(format!("--resolution_type={resolution}"));
        }
        let count = payload_integer(&request.payload, "n", 1).clamp(1, 10);
        args.push(format!("--generate_num={count}"));
        if !request.image_paths.is_empty() {
            args.push(format!(
                "--images={}",
                request
                    .image_paths
                    .iter()
                    .take(10)
                    .map(|path| windows_path_to_wsl(path))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
    } else {
        let cli_model = cli_video_model(&model)
            .ok_or_else(|| format!("OAuth CLI 账号暂不支持视频模型 {model}"))?;
        let mode = payload_string(&request.payload, "functionMode").unwrap_or_default();
        let command = if mode == "omni_reference" {
            "multimodal2video"
        } else {
            match request.image_paths.len() {
                0 => "text2video",
                1 => "image2video",
                _ => "frames2video",
            }
        };
        args.push(command.into());
        args.push(format!("--prompt={prompt}"));
        args.push(format!("--model_version={cli_model}"));
        args.push(format!(
            "--duration={}",
            payload_integer(&request.payload, "duration", 5).clamp(4, 15)
        ));
        if let Some(resolution) = payload_string(&request.payload, "resolution") {
            args.push(format!("--video_resolution={resolution}"));
        }
        if matches!(command, "text2video" | "multimodal2video") {
            if let Some(ratio) = payload_string(&request.payload, "ratio") {
                args.push(format!("--ratio={ratio}"));
            }
        }
        match command {
            "image2video" => {
                args.push(format!(
                    "--image={}",
                    windows_path_to_wsl(&request.image_paths[0])
                ));
            }
            "frames2video" => {
                args.push(format!(
                    "--first={}",
                    windows_path_to_wsl(&request.image_paths[0])
                ));
                args.push(format!(
                    "--last={}",
                    windows_path_to_wsl(&request.image_paths[1])
                ));
            }
            "multimodal2video" => {
                for path in request.image_paths.iter().take(9) {
                    args.push(format!("--image={}", windows_path_to_wsl(path)));
                }
                for path in request.video_paths.iter().take(3) {
                    args.push(format!("--video={}", windows_path_to_wsl(path)));
                }
            }
            _ => {}
        }
    }
    args.push("--poll=900".into());
    let output = run_dreamina(&account.oauth_home, &args, 20 * 60).await?;
    let combined = [output.stdout.as_str(), output.stderr.as_str()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !output.success {
        return Err(if combined.is_empty() {
            "dreamina CLI 调用失败".into()
        } else {
            combined.chars().take(1200).collect()
        });
    }
    let raw = parse_cli_json(&combined);
    let mut urls = Vec::new();
    collect_media_urls(&raw, &mut urls);
    Ok(json!({
        "created": chrono::Utc::now().timestamp(),
        "data": urls.into_iter().map(|url| json!({ "url": url })).collect::<Vec<_>>(),
        "dreamina": raw,
        "auth": "oauth_device",
    }))
}

async fn send_media_once(
    config: &JimengApiConfig,
    account: &JimengAccount,
    endpoint: &str,
    request: &JimengMediaRequest,
) -> Result<Value, String> {
    // The local sidecar can be healthy while an individual browser Session is
    // stale. Fail before submitting a long media task and return an actionable
    // account error instead of making the UI wait for a vague upstream failure.
    validate_session_account(config, account)
        .await
        .map_err(|error| {
            format!(
                "账号 {} 的网页登录态不可用于生成，请在账号池重新完成浏览器登录: {}",
                account.name, error
            )
        })?;
    let client = http_client()?;
    let url = format!("http://127.0.0.1:{}{}", config.port, endpoint);
    let token = token_for_account(account);
    let builder = if request.image_paths.is_empty() && request.video_paths.is_empty() {
        client.post(url).json(&request.payload)
    } else {
        let mut form = add_payload_text(reqwest::multipart::Form::new(), &request.payload);
        if endpoint == "/v1/images/compositions" {
            for path in &request.image_paths {
                form = add_file(form, "images".into(), path)?;
            }
        } else {
            for (index, path) in request.image_paths.iter().enumerate() {
                form = add_file(form, format!("image_file_{}", index + 1), path)?;
            }
            for (index, path) in request.video_paths.iter().enumerate() {
                form = add_file(form, format!("video_file_{}", index + 1), path)?;
            }
        }
        client.post(url).multipart(form)
    };
    let response = builder
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("请求即梦服务失败: {error}"))?;
    response_value(response).await
}

fn is_local_connection_error(error: &str) -> bool {
    let value = error.to_ascii_lowercase();
    value.contains("connection refused")
        || value.contains("actively refused")
        || value.contains("error trying to connect")
        || value.contains("tcp connect error")
}

pub async fn media_request(endpoint: &str, request: JimengMediaRequest) -> Result<Value, String> {
    let config = load_config()?;
    if !config.enabled {
        return Err("即梦 API 服务未启用".into());
    }
    let requested_model = request
        .payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let compatible_accounts = account_candidates(&config, request.account_id.as_deref())
        .into_iter()
        .filter(|account| {
            model_supports_region(requested_model, &account.region)
                && (account.auth_method == "session"
                    || oauth_supports_request(account, endpoint, requested_model))
        })
        .collect::<Vec<_>>();
    if compatible_accounts.is_empty() {
        return Err(format!("没有支持模型 {requested_model} 的可用即梦账号"));
    }
    let accounts = compatible_accounts
        .iter()
        .copied()
        .filter(|account| account_cooldown_remaining(&account.id) == 0)
        .collect::<Vec<_>>();
    if accounts.is_empty() {
        let wait = compatible_accounts
            .iter()
            .map(|account| account_cooldown_remaining(&account.id))
            .filter(|seconds| *seconds > 0)
            .min()
            .unwrap_or(1);
        return Err(format!(
            "支持模型 {requested_model} 的账号暂时均在自愈冷却中，请 {wait} 秒后重试"
        ));
    }
    if accounts
        .iter()
        .any(|account| account.auth_method == "session")
    {
        start_runtime(&config).await?;
    }
    let mut errors = Vec::new();
    for account in accounts {
        let mut result = if account.auth_method == "oauthDevice" {
            send_oauth_media_once(account, endpoint, &request).await
        } else {
            send_media_once(&config, account, endpoint, &request).await
        };
        if account.auth_method == "session"
            && result
                .as_ref()
                .err()
                .map(|error| is_local_connection_error(error))
                .unwrap_or(false)
        {
            logger::log_warn("[JimengAPI] local connection failed; repairing sidecar");
            let _repair_guard = repair_lifecycle().lock().await;
            if restart_runtime(&config).await.is_ok() {
                record_health_success(true).await;
                result = send_media_once(&config, account, endpoint, &request).await;
            }
        }
        match result {
            Ok(mut value) => {
                record_account_success(&account.id);
                if let Some(object) = value.as_object_mut() {
                    object.insert(
                        "cle_account".into(),
                        json!({
                            "id": account.id,
                            "name": account.name,
                            "region": account.region,
                            "authMethod": account.auth_method,
                        }),
                    );
                }
                return Ok(value);
            }
            Err(error) => {
                let kind = if is_local_connection_error(&error) {
                    UpstreamErrorKind::Temporary
                } else {
                    record_account_failure(&account.id, &error)
                };
                errors.push(format!("{}: {}", account.name, error));
                if kind == UpstreamErrorKind::Request {
                    return Err(format!("即梦请求参数或模型不受支持: {error}"));
                }
            }
        }
    }
    Err(format!("所有即梦账号均调用失败: {}", errors.join(" | ")))
}

fn account_action_value_ok(action: &str, value: &Value) -> bool {
    match action {
        "check" => value.get("live").and_then(Value::as_bool) == Some(true),
        "points" => value.as_array().is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    item.get("points").and_then(Value::as_object).is_some()
                        && item.get("error").is_none_or(Value::is_null)
                        && item.get("requiresBrowserLogin").and_then(Value::as_bool) != Some(true)
                })
        }),
        "receive" => value.as_array().is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    item.get("credits").and_then(Value::as_object).is_some()
                        && item.get("error").is_none_or(Value::is_null)
                        && item.get("requiresBrowserLogin").and_then(Value::as_bool) != Some(true)
                })
        }),
        _ => false,
    }
}

fn account_action_requires_login(action: &str, value: &Value, error: Option<&str>) -> bool {
    if action == "check" && value.get("live").and_then(Value::as_bool) == Some(false) {
        return true;
    }
    if value.as_array().is_some_and(|items| {
        items
            .iter()
            .any(|item| item.get("requiresBrowserLogin").and_then(Value::as_bool) == Some(true))
    }) {
        return true;
    }
    let detail = error
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
        .to_ascii_lowercase();
    [
        "login error",
        "token expired",
        "invalid token",
        "shark action check reject",
        "登录",
        "登入",
    ]
    .iter()
    .any(|needle| detail.contains(needle))
}

fn account_action_value_error(action: &str, value: &Value) -> String {
    if action == "check" {
        return "登录态已失效，请使用该账号的“重新登录”按钮完成浏览器登录".into();
    }
    if let Some(error) = value.as_array().and_then(|items| {
        items
            .iter()
            .find_map(|item| item.get("error").and_then(Value::as_str))
    }) {
        return error.to_string();
    }
    match action {
        "points" => "积分接口未返回有效账号数据，请重新浏览器登录后刷新".into(),
        "receive" => "每日积分领取未成功，请重新浏览器登录后再试".into(),
        _ => "即梦账号操作未成功".into(),
    }
}

pub async fn account_action(action: &str, account_id: Option<String>) -> Result<Value, String> {
    let config = load_config()?;
    let accounts = account_candidates(&config, account_id.as_deref());
    if accounts.is_empty() {
        return Err("没有可用的即梦账号".into());
    }
    if accounts
        .iter()
        .any(|account| account.auth_method == "session")
    {
        start_runtime(&config).await?;
    }
    let client = http_client()?;
    let mut results = Vec::new();
    for account in accounts {
        if account.auth_method == "oauthDevice" {
            let output = run_dreamina(&account.oauth_home, &["user_credit".into()], 30).await;
            let (ok, result, error) = match output {
                Ok(output) if output.success => (true, Some(parse_cli_json(&output.stdout)), None),
                Ok(output) => (
                    false,
                    None,
                    Some([output.stdout, output.stderr].join(" ").trim().to_string()),
                ),
                Err(error) => (false, None, Some(error)),
            };
            results.push(json!({
                "accountId": account.id,
                "name": account.name,
                "region": account.region,
                "authMethod": account.auth_method,
                "ok": ok,
                "result": result,
                "error": error,
                "action": if action == "receive" { "OAuth CLI 账号通过 user_credit 验证，不执行网页登录签到" } else { action },
            }));
            continue;
        }
        let token = token_for_account(account);
        let result = match action {
            "check" => {
                let response = client
                    .post(format!("http://127.0.0.1:{}/token/check", config.port))
                    .json(&json!({ "token": token }))
                    .send()
                    .await;
                match response {
                    Ok(response) => response_value(response).await,
                    Err(error) => Err(error.to_string()),
                }
            }
            "points" | "receive" => {
                let response = client
                    .post(format!("http://127.0.0.1:{}/token/{}", config.port, action))
                    .bearer_auth(token)
                    .json(&json!({}))
                    .send()
                    .await;
                match response {
                    Ok(response) => response_value(response).await,
                    Err(error) => Err(error.to_string()),
                }
            }
            _ => return Err("不支持的即梦账号操作".into()),
        };
        let (ok, value, error, requires_login) = match result {
            Ok(value) => {
                let ok = account_action_value_ok(action, &value);
                let error = (!ok).then(|| account_action_value_error(action, &value));
                let requires_login =
                    account_action_requires_login(action, &value, error.as_deref());
                (ok, Some(value), error, requires_login)
            }
            Err(error) => {
                let requires_login =
                    account_action_requires_login(action, &Value::Null, Some(&error));
                (false, None, Some(error), requires_login)
            }
        };
        results.push(json!({
            "accountId": account.id,
            "name": account.name,
            "region": account.region,
            "ok": ok,
            "result": value,
            "error": error,
            "requiresLogin": requires_login,
            "repairUrl": requires_login.then(|| jimeng_login_url(&account.region)),
        }));
    }
    Ok(Value::Array(results))
}

pub async fn diagnose_and_repair() -> Result<Value, String> {
    let _repair_guard = repair_lifecycle().lock().await;
    let mut config = load_config()?;
    normalize_config(&mut config);
    save_config_file(&config)?;
    let mut checks = Vec::new();
    let binary = binary_path();
    checks.push(json!({
        "id": "sidecar",
        "status": if binary.is_ok() { "ok" } else { "error" },
        "detail": binary.as_ref().map(|path| path.display().to_string()).unwrap_or_else(|error| error.clone())
    }));
    let runtime = write_runtime_config(&config);
    checks.push(json!({
        "id": "runtime",
        "status": if runtime.is_ok() { "ok" } else { "error" },
        "detail": runtime.as_ref().map(|path| path.display().to_string()).unwrap_or_else(|error| error.clone())
    }));
    let mut restarted = false;
    if config.enabled && probe_runtime_contract(config.port).await.is_err() {
        restart_runtime(&config).await?;
        restarted = true;
    }
    let health = probe(config.port).await;
    let health_ok = health.is_ok();
    checks.push(json!({
        "id": "health",
        "status": if health_ok { "ok" } else { "error" },
        "detail": format!("http://127.0.0.1:{}/", config.port)
    }));
    let models = probe_models(config.port).await;
    let models_ok = models.is_ok();
    if config.enabled {
        if health_ok && models_ok {
            record_health_success(restarted).await;
        } else {
            let error = health
                .as_ref()
                .err()
                .or_else(|| models.as_ref().err())
                .cloned()
                .unwrap_or_else(|| "jimeng-api contract probe failed".to_string());
            record_health_failure(error).await;
        }
    }
    checks.push(json!({
        "id": "models",
        "status": if models_ok { "ok" } else { "error" },
        "detail": models.map(|count| format!("{count} 个模型")).unwrap_or_else(|error| error)
    }));
    let duplicate_ids = config
        .accounts
        .iter()
        .filter(|account| {
            config
                .accounts
                .iter()
                .filter(|candidate| candidate.id == account.id)
                .count()
                > 1
        })
        .count();
    checks.push(json!({
        "id": "accounts",
        "status": if duplicate_ids > 0 {
            "error"
        } else if config.accounts.iter().any(|account| account.enabled) {
            "ok"
        } else {
            "warning"
        },
        "detail": if duplicate_ids > 0 {
            format!("{duplicate_ids} 个重复账号 ID")
        } else {
            format!("{} 个启用账号", config.accounts.iter().filter(|account| account.enabled).count())
        }
    }));
    let now = chrono::Utc::now().timestamp();
    let cooling_accounts = if let Ok(mut health) = account_health().lock() {
        health.retain(|_, state| state.cooldown_until > now);
        health.len()
    } else {
        0
    };
    checks.push(json!({
        "id": "account-self-healing",
        "status": if cooling_accounts == 0 { "ok" } else { "warning" },
        "detail": if cooling_accounts == 0 {
            "账号故障状态正常；过期冷却记录已自动清理".to_string()
        } else {
            format!("{cooling_accounts} 个账号正在限流/故障退避，冷却结束后自动恢复")
        }
    }));
    let oauth_accounts = config
        .accounts
        .iter()
        .filter(|account| account.enabled && account.auth_method == "oauthDevice")
        .collect::<Vec<_>>();
    if !oauth_accounts.is_empty() {
        checks.push(json!({
            "id": "legacy-oauth-device",
            "status": "warning",
            "detail": format!(
                "{} 个旧版 Device Flow 账号已失效；请用“浏览器登录”重新添加，旧账号不会再参与新登录流程",
                oauth_accounts.len()
            ),
        }));
    } else {
        checks.push(json!({
            "id": "browser-login",
            "status": "ok",
            "detail": "浏览器登录使用隔离配置并保存为 Session 账号",
        }));
    }
    let self_heal = self_heal_snapshot().await;
    checks.push(json!({
        "id": "sidecar-self-healing",
        "status": if matches!(self_heal.status.as_str(), "healthy" | "idle") {
            "ok"
        } else {
            "warning"
        },
        "detail": format!(
            "status={}, consecutiveFailures={}, restartAttempts={}, restartFailures={}, threshold={}, maxBackoff={}s",
            self_heal.status,
            self_heal.consecutive_failures,
            self_heal.restart_attempts,
            self_heal.restart_failures,
            WATCHDOG_FAILURE_THRESHOLD,
            WATCHDOG_MAX_RESTART_COOLDOWN_SECONDS,
        ),
    }));
    Ok(json!({
        "ok": checks.iter().all(|check| check.get("status").and_then(Value::as_str) != Some("error")),
        "restarted": restarted,
        "checks": checks,
        "state": get_state().await?
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_region_and_proxy_to_account_token() {
        let account = JimengAccount {
            id: "id".into(),
            name: "test".into(),
            region: "jp".into(),
            auth_method: "session".into(),
            session_id: "session-token".into(),
            oauth_home: String::new(),
            proxy_url: "http://127.0.0.1:7890".into(),
            priority: 0,
            enabled: true,
        };
        assert_eq!(
            token_for_account(&account),
            "http://127.0.0.1:7890@jp-session-token"
        );
    }

    #[test]
    fn filters_models_by_supported_region() {
        assert!(model_supports_region("jimeng-5.0", "cn"));
        assert!(!model_supports_region("jimeng-5.0", "us"));
        assert!(model_supports_region("jimeng-video-veo3.1", "jp"));
        assert!(!model_supports_region("jimeng-video-veo3.1", "cn"));
        assert!(model_supports_region("future-model", "cn"));
    }

    #[test]
    fn account_actions_require_domain_level_success() {
        assert!(account_action_value_ok("check", &json!({ "live": true })));
        assert!(!account_action_value_ok("check", &json!({ "live": false })));
        assert!(account_action_value_ok(
            "points",
            &json!([{ "points": { "totalCredit": 80 } }])
        ));
        assert!(!account_action_value_ok(
            "points",
            &json!([{ "message": "login error" }])
        ));
        assert!(!account_action_value_ok(
            "points",
            &json!([{
                "points": null,
                "error": "login error",
                "requiresBrowserLogin": true
            }])
        ));
        assert!(account_action_value_ok(
            "receive",
            &json!([{ "credits": { "totalCredit": 80 }, "received": false }])
        ));
        assert!(!account_action_value_ok(
            "receive",
            &json!([{
                "credits": { "totalCredit": 0 },
                "received": false,
                "error": "shark action check reject",
                "requiresBrowserLogin": true
            }])
        ));
    }

    #[test]
    fn account_actions_identify_relogin_conditions() {
        assert!(account_action_requires_login(
            "check",
            &json!({ "live": false }),
            None
        ));
        assert!(account_action_requires_login(
            "receive",
            &json!([{ "requiresBrowserLogin": true }]),
            None
        ));
        assert!(!account_action_requires_login(
            "points",
            &json!([{ "points": { "totalCredit": 80 } }]),
            None
        ));
    }

    #[test]
    fn selects_only_the_expected_login_cookie_for_the_region() {
        let cookies = vec![
            json!({"name": "sessionid", "value": "wrong", "domain": ".example.com"}),
            json!({"name": "sessionid_ss", "value": "cn-fallback", "domain": ".jianying.com"}),
            json!({"name": "sessionid", "value": "cn-primary", "domain": ".jimeng.jianying.com"}),
            json!({"name": "sessionid", "value": "global", "domain": ".dreamina.capcut.com"}),
        ];
        assert_eq!(
            select_session_cookie(&cookies, "cn").as_deref(),
            Some("cn-primary")
        );
        assert_eq!(
            select_session_cookie(&cookies, "jp").as_deref(),
            Some("global")
        );
    }

    #[test]
    fn browser_login_uses_public_product_pages() {
        assert_eq!(
            jimeng_login_url("cn"),
            "https://jimeng.jianying.com/ai-tool/home"
        );
        assert_eq!(
            jimeng_login_url("us"),
            "https://dreamina.capcut.com/ai-tool/home"
        );
    }

    #[test]
    fn classifies_retryable_and_non_retryable_failures() {
        assert_eq!(
            classify_upstream_error("HTTP 401: expired"),
            UpstreamErrorKind::Auth
        );
        assert_eq!(
            classify_upstream_error("browser identity missing: requiresBrowserLogin"),
            UpstreamErrorKind::Auth
        );
        assert_eq!(
            classify_upstream_error("HTTP 429: quota exceeded"),
            UpstreamErrorKind::Quota
        );
        assert_eq!(
            classify_upstream_error("HTTP 503: temporarily unavailable"),
            UpstreamErrorKind::Temporary
        );
        assert_eq!(
            classify_upstream_error("HTTP 400: invalid ratio"),
            UpstreamErrorKind::Request
        );
    }

    #[test]
    fn account_health_recovers_after_success() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        assert_eq!(
            record_account_failure(&id, "HTTP 429: rate limited"),
            UpstreamErrorKind::Quota
        );
        assert!(account_cooldown_remaining(&id) > 0);
        record_account_success(&id);
        assert_eq!(account_cooldown_remaining(&id), 0);
    }

    #[test]
    fn watchdog_restart_backoff_is_bounded() {
        assert_eq!(watchdog_restart_delay(0), Duration::from_secs(30));
        assert_eq!(watchdog_restart_delay(1), Duration::from_secs(60));
        assert_eq!(watchdog_restart_delay(3), Duration::from_secs(240));
        assert_eq!(watchdog_restart_delay(10), Duration::from_secs(300));
    }
}
