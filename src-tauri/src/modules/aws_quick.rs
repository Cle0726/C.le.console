//! AWS Quick (Amazon Quick) accounts through the bundled, separately licensed
//! magpie-AWS-Quick-bridge sidecar (GPL-3.0, separate process, loopback only).
//! Each account has its own folder and its own local gateway; the multi-model
//! API pools them as OpenAI-compatible upstreams under the shared C.le key.
use std::{collections::BTreeMap, fs, io::{BufRead, BufReader}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use serde_json::{json, Value};
use super::config;

pub const PROVIDER: &str = "aws-quick";
pub const SOURCE_PREFIX: &str = "cle:aws-quick:";
pub const MODES: &[&str] = &["smart", "balanced", "fast", "auto"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsQuickAccount {
    pub id: String,
    pub account_id: String,
    pub tenant_url: String,
    pub enterprise: bool,
    pub port: u16,
    pub running: bool,
    #[serde(skip)]
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AwsQuickLogin {
    pub login_id: String,
    pub url: String,
    pub status: String,
    pub message: String,
    pub account_id: String,
}

struct Server { child: Child, _stdin: Option<ChildStdin>, port: u16 }
struct PendingLogin { child: Option<Child>, info: AwsQuickLogin }

static SERVERS: OnceLock<Mutex<BTreeMap<String, Server>>> = OnceLock::new();
static LOGINS: OnceLock<Mutex<BTreeMap<String, PendingLogin>>> = OnceLock::new();
static STOPPED: AtomicBool = AtomicBool::new(false);
fn servers() -> &'static Mutex<BTreeMap<String, Server>> { SERVERS.get_or_init(|| Mutex::new(BTreeMap::new())) }
fn logins() -> &'static Mutex<BTreeMap<String, PendingLogin>> { LOGINS.get_or_init(|| Mutex::new(BTreeMap::new())) }

fn root() -> PathBuf { config::get_shared_dir().join("aws-quick") }
fn accounts_dir() -> PathBuf { root().join("accounts") }
fn protect(path: &Path) {
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700)); }
    #[cfg(not(unix))] { let _ = path; }
}

fn executable() -> Option<PathBuf> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let target = env!("CLE_RUST_TARGET");
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecars/aws-quick/bin");
    [parent.join(format!("cle-aws-quick{ext}")), parent.join(format!("cle-aws-quick-{target}{ext}")),
        parent.join("../Resources").join(format!("cle-aws-quick{ext}")), dev.join(format!("cle-aws-quick-{target}{ext}"))]
        .into_iter().find(|path| path.is_file())
}

fn command(home: &Path) -> Result<Command, String> {
    let exe = executable().ok_or("未找到 AWS Quick 组件（cle-aws-quick），请重新安装 C.le.控制台")?;
    let mut cmd = Command::new(exe);
    cmd.env("AWS_QUICK_BRIDGE_HOME", home).arg("--home").arg(home);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    Ok(cmd)
}

fn read_json(path: &Path) -> Value {
    fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null)
}
fn text(value: &Value, key: &str) -> String { value.get(key).and_then(Value::as_str).unwrap_or_default().to_string() }

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "没有可用本机端口")?;
    listener.local_addr().map(|addr| addr.port()).map_err(|_| "无法读取本机端口".into())
}

/// The port this account's gateway listens on, kept in cle.json beside the
/// sidecar's own files so routes stay stable across restarts.
fn account_port(dir: &Path) -> Result<u16, String> {
    let file = dir.join("cle.json");
    if let Some(port) = read_json(&file).get("port").and_then(Value::as_u64).filter(|p| (1024..=65535).contains(p)) {
        return Ok(port as u16);
    }
    let port = free_port()?;
    super::atomic_write::write_string_atomic(&file, &json!({"port": port}).to_string())?;
    Ok(port)
}

fn safe_id(account_id: &str, tenant: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{account_id}\n{tenant}").as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn list() -> Vec<AwsQuickAccount> {
    let Ok(entries) = fs::read_dir(accounts_dir()) else { return Vec::new() };
    let running = servers().lock().map(|mut map| {
        map.retain(|_, server| matches!(server.child.try_wait(), Ok(None)));
        map.iter().map(|(id, server)| (id.clone(), server.port)).collect::<BTreeMap<_, _>>()
    }).unwrap_or_default();
    let mut out = entries.flatten().filter(|entry| entry.path().is_dir()).filter_map(|entry| {
        let dir = entry.path();
        let id = entry.file_name().to_string_lossy().to_string();
        let account = read_json(&dir.join("account.json"));
        if account.get("access").is_none() { return None; }
        let cfg = read_json(&dir.join("config.json"));
        let port = read_json(&dir.join("cle.json")).get("port").and_then(Value::as_u64).unwrap_or(0) as u16;
        let tenant_url = text(&account, "tenantUrl");
        Some(AwsQuickAccount {
            running: running.contains_key(&id), id, account_id: text(&account, "accountId"),
            enterprise: !matches!(text(&account, "quickProvider").as_str(), "" | "social"), tenant_url, port, api_key: text(&cfg, "apiKey"),
        })
    }).collect::<Vec<_>>();
    out.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    out
}

async fn healthy(port: u16) -> bool {
    let Ok(client) = reqwest::Client::builder().no_proxy().timeout(Duration::from_millis(800)).build() else { return false };
    client.get(format!("http://127.0.0.1:{port}/health")).send().await
        .is_ok_and(|response| response.status().is_success())
}

/// Starts the gateway of every signed-in account that is not running yet.
pub async fn ensure_all() -> Result<Vec<AwsQuickAccount>, String> {
    if STOPPED.load(Ordering::Acquire) { return Err("应用正在退出".into()); }
    for account in list() {
        if account.running { continue; }
        let dir = accounts_dir().join(&account.id);
        let port = account_port(&dir)?;
        // A gateway left over from a previous run serves the same folder: reuse it.
        if healthy(port).await { continue; }
        let mut child = command(&dir)?.arg("serve").arg("--port").arg(port.to_string())
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
            .map_err(|error| format!("AWS Quick 组件无法启动: {error}"))?;
        let stdin = child.stdin.take();
        let mut up = false;
        for _ in 0..50 {
            if child.try_wait().ok().flatten().is_some() { break; }
            if healthy(port).await { up = true; break; }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if !up {
            let _ = child.kill(); let _ = child.wait();
            super::logger::log_warn(&format!("[AWS Quick] {} 的本机网关启动失败", account.account_id));
            continue;
        }
        if let Ok(mut map) = servers().lock() { map.insert(account.id.clone(), Server { child, _stdin: stdin, port }); }
    }
    Ok(list())
}

pub fn stop() {
    STOPPED.store(true, Ordering::Release);
    if let Ok(mut map) = servers().lock() {
        for (_, mut server) in std::mem::take(&mut *map) { let _ = server.child.kill(); let _ = server.child.wait(); }
    }
    if let Ok(mut map) = logins().lock() {
        for (_, mut login) in std::mem::take(&mut *map) { if let Some(mut child) = login.child.take() { let _ = child.kill(); } }
    }
}

fn set_login(login_id: &str, update: impl FnOnce(&mut AwsQuickLogin)) {
    if let Ok(mut map) = logins().lock() { if let Some(login) = map.get_mut(login_id) { update(&mut login.info); } }
}

/// Moves a finished sign-in folder into accounts/<id>; the same account signing
/// in again replaces its tokens and keeps its key and port.
fn adopt(pending: &Path) -> Result<String, String> {
    let account = read_json(&pending.join("account.json"));
    let account_id = text(&account, "accountId");
    let id = safe_id(&account_id, &text(&account, "tenantUrl"));
    let target = accounts_dir().join(&id);
    fs::create_dir_all(accounts_dir()).map_err(|_| "无法创建 AWS Quick 账号目录")?;
    protect(&root()); protect(&accounts_dir());
    if target.join("config.json").is_file() {
        fs::copy(pending.join("account.json"), target.join("account.json")).map_err(|_| "无法保存 AWS Quick 账号")?;
        let _ = fs::remove_dir_all(pending);
    } else {
        let _ = fs::remove_dir_all(&target);
        fs::rename(pending, &target).map_err(|_| "无法保存 AWS Quick 账号")?;
    }
    protect(&target);
    Ok(account_id)
}

pub fn login_start(enterprise: bool, region: String) -> Result<AwsQuickLogin, String> {
    let login_id = uuid::Uuid::new_v4().to_string();
    let pending = root().join("pending").join(&login_id);
    fs::create_dir_all(&pending).map_err(|_| "无法创建登录目录")?;
    protect(&root()); protect(&pending);
    let mut cmd = command(&pending)?;
    cmd.arg("login");
    if enterprise { cmd.arg("--enterprise"); }
    let region = region.trim();
    if !region.is_empty() {
        if !region.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("区域格式无效，例如 us-east-1".into()); }
        cmd.arg("--region").arg(region);
    }
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
        .map_err(|error| format!("AWS Quick 组件无法启动: {error}"))?;
    let stdout = child.stdout.take().ok_or("无法读取登录进程输出")?;
    let mut lines = BufReader::new(stdout).lines();
    let first: Value = lines.next().and_then(Result::ok).and_then(|line| serde_json::from_str(&line).ok()).unwrap_or(Value::Null);
    if text(&first, "event") != "url" {
        let _ = child.kill(); let _ = child.wait(); let _ = fs::remove_dir_all(&pending);
        let message = text(&first, "message");
        return Err(if message.is_empty() { "AWS Quick 登录没有启动".into() } else { format!("AWS Quick 登录失败: {message}") });
    }
    let info = AwsQuickLogin { login_id: login_id.clone(), url: text(&first, "url"), status: "waiting".into(), ..Default::default() };
    logins().lock().map_err(|_| "登录状态被占用")?.insert(login_id.clone(), PendingLogin { child: Some(child), info: info.clone() });
    let id = login_id.clone();
    std::thread::spawn(move || {
        let mut outcome: Option<Value> = None;
        for line in lines.map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if matches!(text(&value, "event").as_str(), "success" | "error") { outcome = Some(value); }
            }
        }
        let child = logins().lock().ok().and_then(|mut map| map.get_mut(&id).and_then(|login| login.child.take()));
        if let Some(mut child) = child { let _ = child.wait(); }
        match outcome {
            Some(value) if text(&value, "event") == "success" => match adopt(&pending) {
                Ok(account_id) => set_login(&id, |info| { info.status = "success".into(); info.account_id = account_id; }),
                Err(error) => set_login(&id, |info| { info.status = "error".into(); info.message = error; }),
            },
            other => {
                let _ = fs::remove_dir_all(&pending);
                let message = other.map(|value| text(&value, "message")).filter(|m| !m.is_empty()).unwrap_or_else(|| "登录已取消或超时".into());
                set_login(&id, |info| { if info.status == "waiting" { info.status = "error".into(); info.message = message; } });
            }
        }
    });
    Ok(info)
}

pub fn login_status(login_id: &str) -> Result<AwsQuickLogin, String> {
    logins().lock().map_err(|_| "登录状态被占用")?.get(login_id).map(|login| login.info.clone()).ok_or_else(|| "登录已结束".into())
}

pub fn login_cancel(login_id: &str) {
    if let Ok(mut map) = logins().lock() {
        if let Some(mut login) = map.remove(login_id) {
            if let Some(mut child) = login.child.take() { let _ = child.kill(); }
        }
    }
}

pub fn remove(id: &str) -> Result<(), String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("账号 ID 无效".into()); }
    if let Ok(mut map) = servers().lock() {
        if let Some(mut server) = map.remove(id) { let _ = server.child.kill(); let _ = server.child.wait(); }
    }
    let dir = accounts_dir().join(id);
    if dir.exists() { fs::remove_dir_all(&dir).map_err(|_| "无法删除 AWS Quick 账号")?; }
    Ok(())
}

/// Plan and quota windows as the sidecar reports them; nothing is invented.
pub async fn quota(id: &str) -> Result<Value, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("账号 ID 无效".into()); }
    let dir = accounts_dir().join(id);
    let mut cmd = command(&dir)?;
    cmd.arg("status").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let output = tokio::task::spawn_blocking(move || cmd.output()).await.map_err(|_| "额度查询中断")?
        .map_err(|error| format!("AWS Quick 组件无法启动: {error}"))?;
    let line = String::from_utf8_lossy(&output.stdout).lines().last().unwrap_or_default().to_string();
    serde_json::from_str(&line).map_err(|_| "额度查询返回格式错误".into())
}

pub async fn start_if_configured() {
    if accounts_dir().is_dir() {
        if let Err(error) = ensure_all().await { super::logger::log_warn(&format!("[AWS Quick] {error}")); }
    }
}
