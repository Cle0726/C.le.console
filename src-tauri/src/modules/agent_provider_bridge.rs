//! Optional personal-use sidecar, separately licensed and bound to loopback.
use std::{collections::BTreeMap, fs, path::PathBuf, process::{Child, Command, Stdio}, sync::{OnceLock, Mutex as StdMutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use super::config;

pub const PROVIDERS: &[&str] = &["qoder", "trae", "raccoon", "catpaw", "autoclaw", "autoclaw-intl", "accio", "loomy"];
pub const CHECKIN_PROVIDERS: &[&str] = &["raccoon", "autoclaw", "autoclaw-intl", "qoder", "trae", "loomy"];
#[derive(Clone, Serialize, Deserialize)]
struct Connection { port: u16, key: String }
struct Runtime { child: Child, connection: Connection }
static RUNTIME: OnceLock<Mutex<Option<Runtime>>> = OnceLock::new();
static STOPPED: AtomicBool = AtomicBool::new(false);
fn runtime() -> &'static Mutex<Option<Runtime>> { RUNTIME.get_or_init(|| Mutex::new(None)) }
fn data_dir() -> PathBuf { config::get_shared_dir().join("extension-providers") }
fn executable() -> Option<PathBuf> {
    let name = if cfg!(windows) { "cle-agent-bridge.exe" } else { "cle-agent-bridge" };
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?;
    [parent.join(name), parent.join("../Resources").join(name),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../sidecars/agent2api/bin/cle-agent-bridge-{}{}", env!("CLE_RUST_TARGET"), if cfg!(windows) { ".exe" } else { "" }))]
        .into_iter().find(|path| path.is_file())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(90)).build().map_err(|_| "扩展组件连接初始化失败".into())
}
fn connection() -> Result<Connection, String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|_| "无法创建扩展账号目录".to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|_| "无法保护扩展账号目录".to_string())?; }
    let file = dir.join("bridge.json");
    if file.exists() {
        let conn: Connection = serde_json::from_slice(&fs::read(&file).map_err(|_| "无法读取扩展连接配置")?).map_err(|_| "扩展连接配置损坏")?;
        if conn.port >= 1024 && conn.key.len() >= 32 { return Ok(conn); }
        return Err("扩展连接配置无效，请保留账号数据并修复 bridge.json".into());
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|_| "没有可用本机端口")?;
    let conn = Connection { port: listener.local_addr().map_err(|_| "无法读取本机端口")?.port(), key: format!("cle-extension-{}", uuid::Uuid::new_v4()) };
    super::atomic_write::write_string_atomic(&file, &serde_json::to_string(&conn).map_err(|_| "无法保存连接配置")?)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).map_err(|_| "无法保护连接配置".to_string())?; }
    Ok(conn)
}
async fn raw(conn: &Connection, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "请求方法无效")?;
    let mut request = client()?.request(method, format!("http://127.0.0.1:{}{}", conn.port, path)).bearer_auth(&conn.key);
    if let Some(body) = body { request = request.json(&body); }
    let mut response = request.send().await.map_err(|_| "扩展组件连接失败或请求超时".to_string())?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "扩展组件响应读取失败")? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 { return Err("扩展组件响应过大".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "扩展组件返回格式错误")?;
    if !status.is_success() || value.get("success").and_then(Value::as_bool) == Some(false) {
        let error = value.get("error").and_then(Value::as_str)
            .or_else(|| value.pointer("/error/message").and_then(Value::as_str)).unwrap_or("上游操作失败");
        return Err(error.chars().take(300).collect());
    }
    Ok(value.get("data").cloned().unwrap_or(value))
}
async fn ensure() -> Result<Connection, String> {
    if STOPPED.load(Ordering::Acquire) { return Err("应用正在退出".into()); }
    let mut guard = runtime().lock().await;
    if let Some(run) = guard.as_mut() {
        if run.child.try_wait().map_err(|_| "扩展进程状态读取失败")?.is_none() { return Ok(run.connection.clone()); }
        *guard = None;
    }
    let exe = executable().ok_or("未安装个人自用扩展组件；请使用个人版构建，账号数据不会丢失")?;
    let conn = connection()?;
    let port_check = std::net::TcpListener::bind(("127.0.0.1", conn.port)).map_err(|_| "扩展端口被占用，请退出重复实例后重试")?;
    drop(port_check);
    let mut child = Command::new(exe).env("AGENT2API_PROXY_HOME", data_dir())
        .env("AGENT2API_HOST", "127.0.0.1").env("AGENT2API_PROXY_PORT", conn.port.to_string())
        .env("AGENT2API_PROXY_API_KEY", &conn.key).env_remove("AGENT2API_ALLOW_NO_KEY")
        .env_remove("AGENT2API_PANEL_PORT").env_remove("AGENT2API_ADMIN_PASSWORD")
        .env_remove("AGENT2API_ADMIN_PASSWORD_HASH").env_remove("AGENT2API_ADMIN_USER")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
        .map_err(|_| "个人自用扩展组件无法启动")?;
    let probe = reqwest::Client::builder().no_proxy().timeout(Duration::from_millis(500)).build().map_err(|_| "探测初始化失败")?;
    for _ in 0..40 {
        if let Some(status) = child.try_wait().map_err(|_| "扩展进程状态读取失败")? { return Err(format!("扩展组件启动退出：{status}")); }
        if probe.get(format!("http://127.0.0.1:{}/api/accounts", conn.port)).bearer_auth(&conn.key).send().await.is_ok_and(|response| response.status().is_success()) {
            if STOPPED.load(Ordering::Acquire) { let _ = child.kill(); let _ = child.wait(); return Err("应用正在退出".into()); }
            *guard = Some(Runtime { child, connection: conn.clone() }); return Ok(conn);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let _ = child.kill(); let _ = child.wait(); Err("扩展组件启动超时".into())
}
pub async fn start_if_configured() {
    let mut reported_error = None;
    while !STOPPED.load(Ordering::Acquire) {
        if data_dir().join("bridge.json").exists() {
            match ensure().await {
                Ok(_) => reported_error = None,
                Err(error) if reported_error.as_ref() != Some(&error) => { super::logger::log_warn(&format!("扩展账号组件：{error}")); reported_error = Some(error); },
                _ => {},
            }
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}
pub fn stop() {
    STOPPED.store(true, Ordering::Release);
    if let Ok(mut guard) = runtime().try_lock() {
        if let Some(mut run) = guard.take() { let _ = run.child.kill(); let _ = run.child.wait(); }
    }
}
static QUOTAS: OnceLock<StdMutex<BTreeMap<String, Value>>> = OnceLock::new();
fn quotas() -> &'static StdMutex<BTreeMap<String, Value>> { QUOTAS.get_or_init(|| StdMutex::new(BTreeMap::new())) }
async fn cache_quotas(conn: &Connection, response: &Value) -> Result<(), String> {
    let accounts = raw(conn, "GET", "/api/accounts", None).await?;
    let rows = response.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    let report_at = response.get("at").and_then(Value::as_i64).unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let mut cache = quotas().lock().map_err(|_| "额度缓存不可用")?;
    for account in accounts.get("accounts").and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = account.get("id").and_then(Value::as_str) else { continue };
        let Some(row) = rows.iter().find(|row| row.get("id").and_then(Value::as_str) == Some(id)) else { continue };
        let at = row.get("at").and_then(Value::as_i64).unwrap_or(report_at);
        if cache.get(id).and_then(|v| v.get("at")).and_then(Value::as_i64).is_some_and(|old| old > at) { continue; }
        let old = cache.get(id);
        let success = row.get("usage").is_some_and(|v| !v.is_null()) && row.get("error").is_none_or(Value::is_null);
        let usage = if success { row.get("usage").cloned() } else { old.and_then(|old| old.get("usage").cloned()) };
        let success_at = if success { Some(at) } else { old.and_then(|old| old.get("successAt")).and_then(Value::as_i64) };
        cache.insert(id.to_string(), json!({"provider": account.get("provider"), "name": account.get("name"), "enabled": account.get("enabled"), "at": at, "successAt": success_at, "error": row.get("error"), "usage": usage}));
    }
    Ok(())
}
pub async fn refresh_quota(provider: &str) -> Result<(), String> {
    let conn = ensure().await?;
    let accounts = raw(&conn, "GET", "/api/accounts", None).await?;
    let mut errors = Vec::new();
    for account in accounts.get("accounts").and_then(Value::as_array).into_iter().flatten().filter(|account| account.get("provider").and_then(Value::as_str) == Some(provider)) {
        let id = account.get("id").and_then(Value::as_str).ok_or("账号 ID 缺失")?;
        if !valid_id(id) { return Err("账号 ID 无效".into()); }
        let report = raw(&conn, "GET", &format!("/api/accounts/usage?id={id}"), None).await?;
        cache_quotas(&conn, &report).await?;
        for row in report.get("results").and_then(Value::as_array).into_iter().flatten() {
            if let Some(error) = row.get("error").and_then(Value::as_str) { errors.push(error.to_string()); }
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.into_iter().take(3).collect::<Vec<_>>().join("；")) }
}
pub fn cached_usage(provider: &str, account_id: &str) -> super::multi_model_api::MultiModelAccountUsage {
    use super::multi_model_api::{MultiModelAccountUsage, MultiModelUsageBucket};
    let cache = quotas().lock().ok();
    let rows = cache.as_ref().map(|cache| cache.iter().filter(|(_, row)| row.get("provider").and_then(Value::as_str) == Some(provider)).collect::<Vec<_>>()).unwrap_or_default();
    let mut buckets = Vec::new(); let mut errors = Vec::new(); let mut updated = None;
    for (id, row) in rows {
        if let Some(error) = row.get("error").and_then(Value::as_str) { errors.push(error.to_string()); }
        let at = row.get("successAt").and_then(Value::as_i64);
        updated = updated.max(at);
        let Some(usage) = row.get("usage").filter(|v| !v.is_null()) else { continue };
        let name = row.get("name").and_then(Value::as_str).unwrap_or(provider);
        let unit = usage.get("unit").and_then(Value::as_str).unwrap_or("");
        if let Some(remaining) = usage.get("available").and_then(Value::as_f64) {
            buckets.push(MultiModelUsageBucket { id: id.clone(), label: format!("{name} · {unit}"), remaining_percent: -1, remaining: Some(remaining), total: None, reset_at: None });
        } else {
            for (index, wallet) in usage.get("wallets").and_then(Value::as_array).into_iter().flatten().enumerate() {
                if let Some(balance) = wallet.get("balance").and_then(Value::as_f64) {
                    let percent = wallet.get("unit").and_then(Value::as_str) == Some("%") || unit == "%";
                    buckets.push(MultiModelUsageBucket { id: format!("{id}:{index}"), label: format!("{name} · {}", wallet.get("displayName").and_then(Value::as_str).unwrap_or("余额")),
                        remaining_percent: if percent { balance.round().clamp(0.,100.) as i32 } else { -1 }, remaining: Some(balance), total: percent.then_some(100.), reset_at: None });
                }
            }
        }
    }
    MultiModelAccountUsage { account_id: account_id.into(), updated_at: updated.and_then(chrono::DateTime::from_timestamp_millis).map(|time| time.to_rfc3339()),
        status: if errors.is_empty() { "normal" } else { "error" }.into(), status_reason: (!errors.is_empty()).then(|| errors.join("；")), buckets }
}
fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 180 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
pub fn allowed(method: &str, path: &str) -> bool {
    if path.contains(['#', '%', '\\']) || path.contains("..") { return false; }
    let (base, query) = path.split_once('?').unwrap_or((path, ""));
    let query_allowed = query.is_empty() || (base == "/api/session/login/wait" && query.strip_prefix("state=").is_some_and(valid_id))
        || (base == "/api/accounts/usage" && query.strip_prefix("id=").is_some_and(valid_id));
    if !query_allowed { return false; }
    match (method, base) {
        ("GET", "/api/accounts" | "/api/accounts/usage" | "/api/accounts/usage/snapshot" | "/api/checkin-center" | "/api/auto-checkin" | "/api/models/manage" | "/api/session/login/wait") => true,
        ("POST", "/api/accounts" | "/api/accounts/checkin" | "/api/models/refresh" | "/api/auto-checkin" | "/api/auto-checkin/run" | "/api/session/login/start" | "/api/session/login/cancel" | "/api/session/login/callback" | "/api/session/login/sms/send" | "/api/session/login/sms/verify" | "/api/session/login/loomy/sms/send" | "/api/session/login/loomy/sms/verify") => true,
        ("PATCH" | "DELETE", _) => base.strip_prefix("/api/accounts/").is_some_and(valid_id), _ => false,
    }
}
fn redact(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| {
                let key = key.chars().filter(|c| c.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
                !["accesstoken", "refreshtoken", "apikey", "token", "credentials", "password", "secret", "cookie", "authorization", "clientsecret", "privatekey"].contains(&key.as_str())
            });
            object.values_mut().for_each(redact);
        }, Value::Array(items) => items.iter_mut().for_each(redact), _ => {},
    }
}
pub async fn request(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !allowed(&method, &path) { return Err("不允许访问此扩展接口".into()); }
    if let Some(provider) = body.as_ref().and_then(|v| v.get("provider")).and_then(Value::as_str) {
        if !PROVIDERS.contains(&provider) { return Err("此渠道未接入个人扩展账号池".into()); }
    }
    if path == "/api/auto-checkin" && method == "POST" {
        if let Some(providers) = body.as_ref().and_then(|v| v.get("providers")).and_then(Value::as_array) {
            if providers.is_empty() || providers.iter().any(|v| !v.as_str().is_some_and(|s| CHECKIN_PROVIDERS.contains(&s))) { return Err("请选择有真实签到接口的渠道".into()); }
        }
    }
    let conn = ensure().await?;
    let mut response = raw(&conn, &method, &path, body).await?;
    if method == "GET" && path.starts_with("/api/accounts/usage") { cache_quotas(&conn, &response).await?; }
    redact(&mut response); Ok(response)
}
pub struct Pool { pub provider: String, pub count: usize, pub base_url: String, pub key: String, pub models: Vec<Value> }
pub async fn pools(refresh: bool) -> Result<Vec<Pool>, String> {
    let conn = ensure().await?;
    if refresh {
        let report = raw(&conn, "POST", "/api/models/refresh", Some(json!({"providers": PROVIDERS}))).await?;
        if report.get("failed").and_then(Value::as_u64).unwrap_or(0) > 0 {
            let failures = report.get("results").and_then(Value::as_array).into_iter().flatten().filter(|row| row.get("status").and_then(Value::as_str) == Some("failed"))
                .map(|row| format!("{}：{}", row.get("provider").and_then(Value::as_str).unwrap_or("渠道"), row.get("message").or_else(|| row.get("error")).and_then(Value::as_str).unwrap_or("目录查询失败"))).collect::<Vec<_>>();
            return Err(format!("模型目录没有完全同步，保留上次配置。{}", failures.join("；")));
        }
    }
    let accounts = raw(&conn, "GET", "/api/accounts", None).await?;
    let models = raw(&conn, "GET", "/api/models/manage", None).await?;
    let mut keys = raw(&conn, "GET", "/api/keys", None).await?;
    let mut pools = Vec::new();
    for provider in PROVIDERS {
        let count = accounts.get("accounts").and_then(Value::as_array).map(|items| items.iter().filter(|item| item.get("provider").and_then(Value::as_str) == Some(provider) && item.get("enabled").and_then(Value::as_bool) != Some(false)).count()).unwrap_or(0);
        if count == 0 { continue; }
        let name = format!("C.le pool: {provider}");
        let find_key = |keys: &Value| keys.get("keys").and_then(Value::as_array).and_then(|items| items.iter().find(|key| key.get("name").and_then(Value::as_str) == Some(name.as_str()) && key.get("enabled").and_then(Value::as_bool) == Some(true) && key.get("allowedProviders") == Some(&json!([provider])))).and_then(|key| key.get("key")).and_then(Value::as_str).map(str::to_string);
        if find_key(&keys).is_none() { keys = raw(&conn, "POST", "/api/keys", Some(json!({"name": name, "allowedProviders": [provider]}))).await?; }
        let key = find_key(&keys).ok_or("无法创建渠道隔离密钥")?;
        let models = models.get("models").and_then(Value::as_array).map(|items| items.iter().filter(|item| item.get("provider").and_then(Value::as_str) == Some(provider) && item.get("enabled").and_then(Value::as_bool) != Some(false)).cloned().collect()).unwrap_or_default();
        pools.push(Pool { provider: provider.to_string(), count, base_url: format!("http://127.0.0.1:{}/v1", conn.port), key, models });
    }
    Ok(pools)
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn no_inference_export_or_keepalive() {
        for path in ["/v1/chat/completions", "/api/accounts/export", "/api/keys", "/api/update", "/api/accounts/../keys"] { assert!(!allowed("GET", path)); assert!(!allowed("POST", path)); }
        assert!(allowed("GET", "/api/session/login/wait?state=safe_123")); assert!(!allowed("GET", "/api/session/login/wait?state=x&url=evil"));
        assert!(allowed("GET", "/api/accounts/usage?id=account-1")); assert!(!CHECKIN_PROVIDERS.contains(&"workbuddy-intl")); assert!(!CHECKIN_PROVIDERS.contains(&"kuku"));
    }
    #[test] fn no_tokens_in_webview() {
        let mut value = json!({"id":"1", "accessToken":"private", "nested":{"refreshToken":"private", "status":"ok"}});
        redact(&mut value); assert_eq!(value, json!({"id":"1", "nested":{"status":"ok"}}));
    }
}
