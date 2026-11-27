//! AWS Quick (Amazon Quick) accounts through the bundled, separately licensed
//! magpie-AWS-Quick-bridge sidecar (GPL-3.0, separate process, loopback only).
//! Each account has its own folder and its own local gateway; the multi-model
//! API pools them as OpenAI-compatible upstreams under the shared C.le key.
use std::{collections::BTreeMap, fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use serde_json::{json, Value};
use super::config;
use super::multi_model_api::{MultiModelAccountUsage, MultiModelUsageBucket};

pub const PROVIDER: &str = "aws-quick";
pub const SOURCE_PREFIX: &str = "cle:aws-quick:";
/// The one route the multi-model API keeps for AWS Quick: the sidecar's pool
/// address (multi), which picks an account with allowance left for each turn
/// and keeps a conversation on its account.
pub const POOL_SOURCE: &str = "cle:aws-quick:pool";
pub const POOL_ROUTE_ID: &str = "cle-aws-quick-pool";
/// The header the pool keeps a conversation on its account by; the API fills
/// it with the conversation id it derives for every request.
pub const CONVERSATION_HEADER: &str = "x-aws-quick-conversation";
/// The models clients ask for and the Amazon Quick mode each one is. Quick
/// names the model behind every mode in its usage (seen on a real account,
/// 2026-11): smart = Claude Opus 5.5, balanced = Sonnet 5.5, fast = Haiku 5.5.
pub const MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "smart"),
    ("claude-sonnet-5-5", "balanced"),
    ("claude-haiku-5-5", "fast"),
];

/// The Quick mode the bridge is asked for, for `aws-quick/<model>`.
pub fn upstream_mode(model_id: &str) -> Option<&'static str> {
    let model = model_id.strip_prefix(&format!("{PROVIDER}/")).unwrap_or(model_id);
    MODELS.iter().find(|(name, _)| *name == model).map(|(_, mode)| *mode)
}

/// What a model saved under 1.1.57's mode names is called now; auto ran Opus.
pub fn renamed(model_id: &str) -> Option<String> {
    let mode = model_id.strip_prefix(&format!("{PROVIDER}/"))?;
    let mode = if mode == "auto" { "smart" } else { mode };
    MODELS.iter().find(|(_, m)| *m == mode).map(|(name, _)| format!("{PROVIDER}/{name}"))
}

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
/// One `cle-aws-quick multi` serving every account on its own port, in place of one `serve` each.
static MULTI: OnceLock<Mutex<Option<Server>>> = OnceLock::new();
fn multi() -> &'static Mutex<Option<Server>> { MULTI.get_or_init(|| Mutex::new(None)) }
fn multi_alive() -> bool {
    multi().lock().map(|mut slot| {
        if slot.as_mut().is_some_and(|server| !matches!(server.child.try_wait(), Ok(None))) { *slot = None; }
        slot.is_some()
    }).unwrap_or(false)
}
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

/// The sidecar takes its subcommand first: `cle-aws-quick <login|serve|status> --home <dir>`.
fn command(subcommand: &str, home: &Path) -> Result<Command, String> {
    let exe = executable().ok_or("未找到 AWS Quick 组件（cle-aws-quick），请重新安装 C.le.控制台")?;
    let mut cmd = Command::new(exe);
    cmd.env("AWS_QUICK_BRIDGE_HOME", home).arg(subcommand).arg("--home").arg(home);
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

/// The pool address `multi` serves (<root>/pool.json: port, apiKey).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pool { pub port: u16, pub api_key: String }

pub(crate) fn parse_pool(value: &Value) -> Option<Pool> {
    let api_key = value.get("apiKey").and_then(Value::as_str).map(str::trim).filter(|key| !key.is_empty())?.to_string();
    let port = match value.get("port").and_then(Value::as_u64) {
        None | Some(0) => 4400,
        Some(port) if (1024..=65535).contains(&port) => port as u16,
        Some(_) => return None,
    };
    Some(Pool { port, api_key })
}

/// The pool, once `multi` has made it; None where it never ran (an old sidecar
/// that only has `serve`), which keeps one route per account.
pub fn pool() -> Option<Pool> { parse_pool(&read_json(&root().join("pool.json"))) }

pub fn list() -> Vec<AwsQuickAccount> {
    let Ok(entries) = fs::read_dir(accounts_dir()) else { return Vec::new() };
    let all = multi_alive();
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
            running: all || running.contains_key(&id), id, account_id: text(&account, "accountId"),
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

/// Starts `cle-aws-quick multi` for the accounts folder: one process that
/// serves every account on its own port and picks up accounts added later.
/// It ends when the console does (its stdin closes).
async fn start_multi(ports: &[u16]) -> bool {
    if multi_alive() { return true; }
    let Some(exe) = executable() else { return false };
    let mut cmd = Command::new(exe);
    cmd.arg("multi").arg("--accounts").arg(accounts_dir()).arg("--exit-with-stdin");
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let Ok(mut child) = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return false };
    let stdin = child.stdin.take();
    for _ in 0..50 {
        if child.try_wait().ok().flatten().is_some() { return false; }
        let mut up = true;
        for port in ports { if !healthy(*port).await { up = false; break; } }
        if up { break; }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    if let Ok(mut slot) = multi().lock() { *slot = Some(Server { child, _stdin: stdin, port: 0 }); }
    true
}

/// Starts the gateway of every signed-in account that is not running yet:
/// all of them in one `multi` process, or, where that cannot start (an old
/// sidecar), one `serve` each as before.
pub async fn ensure_all() -> Result<Vec<AwsQuickAccount>, String> {
    if STOPPED.load(Ordering::Acquire) { return Err("应用正在退出".into()); }
    let mut wanted = Vec::new();
    for account in list() {
        if account.running { continue; }
        let port = account_port(&accounts_dir().join(&account.id))?;
        if !healthy(port).await { wanted.push(port); }
    }
    if !wanted.is_empty() && start_multi(&wanted).await {
        // multi takes a new account's port within a second or so
        for _ in 0..25 {
            let mut up = true;
            for port in &wanted { if !healthy(*port).await { up = false; break; } }
            if up { break; }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    for account in list() {
        if account.running { continue; }
        let dir = accounts_dir().join(&account.id);
        let port = account_port(&dir)?;
        // A gateway left over from a previous run serves the same folder: reuse it.
        if healthy(port).await { continue; }
        let mut child = command("serve", &dir)?.arg("--port").arg(port.to_string())
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
    if let Ok(mut slot) = multi().lock() {
        if let Some(mut server) = slot.take() { let _ = server.child.kill(); let _ = server.child.wait(); }
    }
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
    let mut cmd = command("login", &pending)?;
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

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AwsQuickImport {
    pub imported: Vec<String>,
    pub warnings: Vec<String>,
    pub failed: Vec<String>,
}

/// The accounts in pasted text: one JSON object, a JSON array of them, or a
/// bare access token. A token only works on its account's own cell, which it
/// does not name, so `tenant_url` fills in entries that lack one.
fn import_items(text: &str, tenant_url: &str) -> Result<Vec<Value>, String> {
    let tenant_url = tenant_url.trim();
    if !tenant_url.is_empty() && !tenant_url.starts_with("https://") { return Err("tenantUrl 应以 https:// 开头".into()); }
    let mut items = parse_import(text)?;
    if !tenant_url.is_empty() {
        for item in &mut items {
            let Some(object) = item.as_object_mut() else { continue };
            if !["tenantUrl", "tenant_url"].iter().any(|key| object.get(*key).and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty())) {
                object.insert("tenantUrl".into(), Value::String(tenant_url.to_string()));
            }
        }
    }
    Ok(items)
}

fn parse_import(text: &str) -> Result<Vec<Value>, String> {
    let text = text.trim().trim_start_matches('\u{feff}');
    if text.is_empty() { return Err("请粘贴 account.json 内容或 access token".into()); }
    if text.starts_with('{') || text.starts_with('[') {
        return match serde_json::from_str::<Value>(text).map_err(|error| format!("JSON 格式错误: {error}"))? {
            Value::Array(items) if !items.is_empty() => Ok(items),
            Value::Array(_) => Err("JSON 数组里没有账号".into()),
            value => Ok(vec![value]),
        };
    }
    let token = text.strip_prefix("Bearer ").unwrap_or(text).trim();
    if token.chars().any(char::is_whitespace) { return Err("无法识别：请粘贴 JSON，或单独一个 access token".into()); }
    Ok(vec![json!({ "access": token })])
}

fn import_one(item: &Value) -> Result<(String, String), String> {
    let pending = root().join("pending").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&pending).map_err(|_| "无法创建导入目录")?;
    protect(&root()); protect(&pending);
    let result = (|| -> Result<(String, String), String> {
        let mut child = command("import", &pending)?.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
            .map_err(|error| format!("AWS Quick 组件无法启动: {error}"))?;
        if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(item.to_string().as_bytes()); }
        let output = child.wait_with_output().map_err(|error| format!("AWS Quick 导入中断: {error}"))?;
        let last: Value = String::from_utf8_lossy(&output.stdout).lines().rev()
            .find_map(|line| serde_json::from_str(line).ok()).unwrap_or(Value::Null);
        match text(&last, "event").as_str() {
            "success" => Ok((adopt(&pending)?, text(&last, "warning"))),
            "error" => Err(text(&last, "message")),
            _ => Err("AWS Quick 组件没有返回结果，请确认 C.le.控制台 是最新版".to_string()),
        }
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&pending); }
    result
}

/// Imports pasted accounts. Amazon Quick checks each token before it is kept;
/// one bad entry does not stop the others.
pub fn import(text: &str, tenant_url: &str) -> Result<AwsQuickImport, String> {
    let items = import_items(text, tenant_url)?;
    let many = items.len() > 1;
    let mut out = AwsQuickImport::default();
    for (index, item) in items.iter().enumerate() {
        let label = if many { format!("第 {} 个：", index + 1) } else { String::new() };
        match import_one(item) {
            Ok((account_id, warning)) => {
                if !warning.is_empty() { out.warnings.push(format!("{label}{warning}")); }
                out.imported.push(account_id);
            }
            Err(error) => out.failed.push(format!("{label}{error}")),
        }
    }
    if out.imported.is_empty() { return Err(out.failed.join("；")); }
    Ok(out)
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

#[derive(Clone, Default)]
struct CachedUsage { updated_at: Option<String>, status: String, status_reason: Option<String>, buckets: Vec<MultiModelUsageBucket> }

fn usage_cache() -> &'static Mutex<BTreeMap<String, CachedUsage>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, CachedUsage>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// The sidecar's quota windows (credits used of a limit, or a percentage used)
/// as the shared quota buckets; nothing is invented.
fn buckets(status: &Value) -> Vec<MultiModelUsageBucket> {
    let plan = text(status, "plan");
    status.get("windows").and_then(Value::as_array).into_iter().flatten().filter_map(|window| {
        let name = text(window, "name");
        let label = match name.as_str() { "Monthly" => "月度额度", "Session" => "会话额度", "Monthly overage" => "月度超额", other => other }.to_string();
        let limit = window.get("limit").and_then(Value::as_f64).filter(|limit| *limit > 0.0);
        let (remaining, total, remaining_percent) = match limit {
            Some(limit) => {
                let left = (limit - window.get("amount").and_then(Value::as_f64).unwrap_or(0.0)).max(0.0);
                (Some(left), Some(limit), ((left / limit) * 100.0).round() as i32)
            }
            None => (None, None, (100.0 - window.get("used").and_then(Value::as_f64)?).clamp(0.0, 100.0).round() as i32),
        };
        let reset_at = window.get("resetsAt").and_then(Value::as_str).map(str::to_string).or_else(|| {
            window.get("resetSecs").and_then(Value::as_i64).map(|secs| (chrono::Utc::now() + chrono::Duration::seconds(secs)).to_rfc3339())
        });
        Some(MultiModelUsageBucket { id: name.to_ascii_lowercase().replace(' ', "-"),
            label: if plan.is_empty() { label } else { format!("{plan} · {label}") }, remaining_percent, remaining, total, reset_at })
    }).collect()
}

/// Keeps a quota answer for the shared quota view and says whether it was
/// one; a failed query keeps the last buckets and records why.
fn cache_quota(id: &str, status: Result<&Value, &str>) -> Result<(), String> {
    let verdict = match status {
        Err(error) => Err(("error", error.to_string())),
        Ok(status) => {
            let error = text(status, "error");
            if status.get("signedIn").and_then(Value::as_bool) == Some(false) { Err(("login_required", "AWS Quick 账号未登录，请重新登录或导入".to_string())) }
            else if status.get("expired").and_then(Value::as_bool) == Some(true) { Err(("login_required", format!("AWS Quick 登录已过期，请重新登录或导入（{error}）"))) }
            else if !error.is_empty() { Err(("error", format!("AWS Quick 额度查询失败：{error}"))) }
            else { Ok(buckets(status)) }
        }
    };
    let mut cache = usage_cache().lock().map_err(|_| "额度缓存被占用".to_string())?;
    let entry = cache.entry(id.to_string()).or_default();
    match verdict {
        Ok(buckets) => { *entry = CachedUsage { updated_at: Some(chrono::Utc::now().to_rfc3339()), status: "normal".into(), status_reason: None, buckets }; Ok(()) }
        Err((status, reason)) => { entry.status = status.into(); entry.status_reason = Some(reason.clone()); Err(reason) }
    }
}

/// For the shared quota refresh: fails when Amazon Quick gave no quota.
pub async fn refresh_quota(id: &str) -> Result<(), String> {
    match quota_raw(id).await {
        Ok(status) => cache_quota(id, Ok(&status)),
        Err(error) => { let _ = cache_quota(id, Err(&error)); Err(error) }
    }
}

pub fn usage(id: &str, route_id: &str) -> Option<MultiModelAccountUsage> {
    let cached = usage_cache().lock().ok()?.get(id).cloned()?;
    Some(MultiModelAccountUsage { account_id: route_id.into(), updated_at: cached.updated_at, status: cached.status,
        status_reason: cached.status_reason, buckets: cached.buckets })
}

/// Plan and quota windows as the sidecar reports them, for the panel; the
/// answer is also kept for the shared quota view.
pub async fn quota(id: &str) -> Result<Value, String> {
    let status = quota_raw(id).await?;
    let _ = cache_quota(id, Ok(&status));
    Ok(status)
}

async fn quota_raw(id: &str) -> Result<Value, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("账号 ID 无效".into()); }
    let dir = accounts_dir().join(id);
    let mut cmd = command("status", &dir)?;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_windows_become_buckets() {
        let status = json!({"event": "status", "plan": "Free Trial", "windows": [
            {"name": "Monthly", "amount": 420, "limit": 600, "unit": "credits", "resetsAt": "2026-12-01T00:00:00.000Z"},
            {"name": "Session", "amount": 38, "limit": 100, "resetSecs": 600},
            {"name": "Monthly overage", "used": 25}]});
        let buckets = buckets(&status);
        assert_eq!(buckets.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["monthly", "session", "monthly-overage"]);
        assert_eq!(buckets[0].label, "Free Trial · 月度额度");
        assert_eq!((buckets[0].remaining, buckets[0].total, buckets[0].remaining_percent), (Some(180.0), Some(600.0), 30));
        assert_eq!(buckets[0].reset_at.as_deref(), Some("2026-12-01T00:00:00.000Z"));
        assert_eq!(buckets[1].remaining_percent, 62);
        assert!(buckets[1].reset_at.is_some());
        assert_eq!((buckets[2].remaining, buckets[2].remaining_percent), (None, 75));
    }

    #[test]
    fn pasted_text_becomes_accounts() {
        assert_eq!(import_items("  Bearer abc  ", "").unwrap(), vec![json!({"access": "abc"})]);
        assert_eq!(import_items("abc", "https://cell.example").unwrap(), vec![json!({"access": "abc", "tenantUrl": "https://cell.example"})]);
        let both = import_items(r#"[{"access":"a","tenant_url":"https://own"},{"access":"b"}]"#, "https://given").unwrap();
        assert!(both[0].get("tenantUrl").is_none());
        assert_eq!(both[1]["tenantUrl"], "https://given");
        assert!(import_items("", "").is_err());
        assert!(import_items("two words", "").is_err());
        assert!(import_items("[]", "").is_err());
        assert!(import_items("{bad", "").is_err());
        assert!(import_items("abc", "http://plain").is_err());
    }

    #[test]
    fn sidecar_takes_its_subcommand_first() {
        let Ok(cmd) = command("status", Path::new("home")) else { return };
        let args = cmd.get_args().map(|arg| arg.to_string_lossy().to_string()).collect::<Vec<_>>();
        assert_eq!(args, ["status", "--home", "home"]);
    }

    #[test]
    fn pool_json_gives_the_pool_address() {
        assert_eq!(parse_pool(&json!({"port": 4400, "apiKey": "sk-quick-pool-a"})), Some(Pool { port: 4400, api_key: "sk-quick-pool-a".into() }));
        assert_eq!(parse_pool(&json!({"apiKey": "k"})).map(|p| p.port), Some(4400));
        assert_eq!(parse_pool(&json!({"port": 4400})), None);
        assert_eq!(parse_pool(&json!({"port": 4400, "apiKey": "  "})), None);
        assert_eq!(parse_pool(&json!({"port": 80, "apiKey": "k"})), None);
        assert_eq!(parse_pool(&Value::Null), None);
    }

    #[test]
    fn real_model_names_map_to_quick_modes() {
        assert_eq!(upstream_mode("aws-quick/claude-opus-5-5"), Some("smart"));
        assert_eq!(upstream_mode("aws-quick/claude-sonnet-5-5"), Some("balanced"));
        assert_eq!(upstream_mode("claude-haiku-5-5"), Some("fast"));
        assert_eq!(upstream_mode("aws-quick/smart"), None);
        assert_eq!(renamed("aws-quick/smart").as_deref(), Some("aws-quick/claude-opus-5-5"));
        assert_eq!(renamed("aws-quick/auto").as_deref(), Some("aws-quick/claude-opus-5-5"));
        assert_eq!(renamed("aws-quick/fast").as_deref(), Some("aws-quick/claude-haiku-5-5"));
        assert_eq!(renamed("aws-quick/claude-opus-5-5"), None);
        assert_eq!(renamed("doubao-web/fast"), None);
    }

    #[test]
    fn models_declare_vision_thinking_and_limits() {
        let models = super::super::multi_model_api::aws_quick_models_for_test();
        assert!(models.iter().all(|m| m.capabilities.iter().any(|c| c == "vision") && m.capabilities.iter().any(|c| c == "reasoning")));
        assert!(models.iter().all(|m| m.max_input_tokens == Some(128_000) && m.max_output_tokens == Some(64_000)));
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["aws-quick/claude-opus-5-5", "aws-quick/claude-sonnet-5-5", "aws-quick/claude-haiku-5-5"]);
    }
}
