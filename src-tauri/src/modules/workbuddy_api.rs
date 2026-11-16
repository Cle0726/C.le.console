//! WorkBuddy wire contract adapted from workbuddy2api-hub (MIT).
//! See sidecars/cle-cliproxy/WORKBUDDY-NOTICE.md for provenance.
//! Credentials are read/refreshed by C.le, never duplicated into the gateway.

use crate::models::workbuddy::WorkbuddyAccount;
use crate::modules::{
    multi_model_api::{MultiModelDefinition, MultiModelUsageBucket},
    workbuddy_account,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

#[derive(Clone)]
pub struct CredentialBridge {
    pub address: String,
    secret: String,
}

static BRIDGE: OnceLock<CredentialBridge> = OnceLock::new();

pub fn descriptor() -> Option<CredentialBridge> {
    BRIDGE.get().cloned()
}

impl CredentialBridge {
    pub fn key(&self, account_id: &str) -> String {
        format!("{}:{account_id}", self.secret)
    }

    pub fn url(&self, account_id: &str) -> String {
        format!("{}/credentials/{account_id}", self.address)
    }
}

fn bridge_state() -> &'static Mutex<Option<CredentialBridge>> {
    static STATE: OnceLock<Mutex<Option<CredentialBridge>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

pub async fn ensure_bridge() -> Result<CredentialBridge, String> {
    // Runtime files contain the internal bridge capability. Restrict the whole
    // directory before writing it, including atomic-write backups and auth files.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let directory = crate::modules::account::get_data_dir()?.join("multi_model_api_service");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let mut state = bridge_state().lock().await;
    if let Some(bridge) = state.as_ref() {
        return Ok(bridge.clone());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let bridge = CredentialBridge {
        address: format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        ),
        secret: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
    };
    let server = bridge.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let bridge = server.clone();
            tokio::spawn(async move {
                let _ = timeout(Duration::from_secs(45), serve_credentials(socket, bridge)).await;
            });
        }
    });
    *state = Some(bridge.clone());
    let _ = BRIDGE.set(bridge.clone());
    Ok(bridge)
}

async fn serve_credentials(mut socket: TcpStream, bridge: CredentialBridge) -> Result<(), String> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 1024];
    while raw.len() < 8192 && !raw.windows(4).any(|part| part == b"\r\n\r\n") {
        let size = socket.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if size == 0 {
            return Ok(());
        }
        raw.extend_from_slice(&chunk[..size]);
    }
    let request = String::from_utf8_lossy(&raw);
    let mut lines = request.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split_whitespace();
    let method = start.next().unwrap_or_default();
    let target = start.next().unwrap_or_default();
    let account_id = target
        .split('?')
        .next()
        .unwrap_or_default()
        .strip_prefix("/credentials/")
        .unwrap_or_default();
    let authorization = lines
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization")
                .then(|| value.trim())
        })
        .unwrap_or_default();
    let (status, payload) = if method != "GET"
        || account_id.is_empty()
        || !account_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '~')
    {
        (400, json!({"error": "invalid credential request"}))
    } else if authorization != format!("Bearer {}", bridge.key(account_id)) {
        (
            401,
            json!({"error": "credential bridge authentication failed"}),
        )
    } else {
        let payload = if let Some((provider, id)) = account_id.split_once('~') {
            crate::modules::managed_provider_api::credential_payload(provider, id, target.ends_with("?refresh=1")).await
        } else {
            current_account(account_id, target.ends_with("?refresh=1")).await.map(|account| credential_payload(&account))
        };
        match payload {
            Ok(payload) => (200, payload),
            Err(_) => (401, json!({"error": "登录凭证不可用，请在 C.le 账号页刷新或重新登录"})),
        }
    };
    let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let headers = format!("HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        if status == 200 { "OK" } else { "Error" }, body.len());
    socket
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    socket.write_all(&body).await.map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn current_account(id: &str, force_refresh: bool) -> Result<WorkbuddyAccount, String> {
    let account = workbuddy_account::load_account(id).ok_or("WorkBuddy 账号已删除")?;
    if force_refresh
        || account
            .expires_at
            .is_some_and(|at| at <= chrono::Utc::now().timestamp() + 120)
    {
        let (fresh, diagnostics) = workbuddy_account::refresh_account_detailed(id).await?;
        // A refresh error does not invalidate an access token that the quota
        // endpoint has just accepted. An expired/rejected token still fails.
        if let Some(error) = diagnostics.token_error {
            if !diagnostics.quota_refreshed
                || fresh.expires_at.is_some_and(|at| at <= chrono::Utc::now().timestamp()) {
                return Err(error);
            }
        }
        if fresh.access_token.trim().is_empty() {
            return Err("WorkBuddy 缺少登录凭证".into());
        }
        if fresh.status.as_deref() == Some("login_required") {
            return Err("WorkBuddy 登录已失效，原账号和凭证仍已保留，请重新授权".into());
        }
        return Ok(fresh);
    }
    if account.access_token.trim().is_empty() || account.status.as_deref() == Some("login_required")
    {
        return Err("WorkBuddy 登录已失效，请在账号页重新登录".into());
    }
    Ok(account)
}

pub fn credit_bucket(account: &WorkbuddyAccount) -> Option<MultiModelUsageBucket> {
    let resources = account
        .quota_raw
        .as_ref()
        .and_then(|root| root.get("userResource"))
        .or(account.usage_raw.as_ref())?
        .pointer("/data/Response/Data/Accounts")?
        .as_array()?;
    let number = |item: &Value, keys: &[&str]| {
        keys.iter()
            .find_map(|key| {
                item.get(*key)
                    .and_then(|value| {
                        value
                            .as_f64()
                            .or_else(|| value.as_str()?.parse::<f64>().ok())
                    })
                    .filter(|n| n.is_finite())
            })
            .unwrap_or(0.0)
            .max(0.0)
    };
    let mut total = 0.0;
    let mut remaining = 0.0;
    let mut active = false;
    for resource in resources
        .iter()
        .filter(|item| matches!(item.get("Status").and_then(Value::as_i64), Some(0 | 3)))
    {
        active = true;
        total += number(
            resource,
            &[
                "CycleCapacitySizePrecise",
                "CycleCapacitySize",
                "CapacitySizePrecise",
                "CapacitySize",
            ],
        );
        remaining += number(
            resource,
            &[
                "CycleCapacityRemainPrecise",
                "CycleCapacityRemain",
                "CapacityRemainPrecise",
                "CapacityRemain",
            ],
        );
    }
    active.then(|| MultiModelUsageBucket {
        id: "credits".into(),
        label: "可用积分".into(),
        remaining_percent: if total > 0.0 {
            (remaining / total * 100.0).clamp(0.0, 100.0).round() as i32
        } else {
            0
        },
        remaining: Some(remaining),
        total: Some(total),
        reset_at: None,
    })
}

pub fn chat_base(account: &WorkbuddyAccount) -> &'static str {
    if crate::modules::workbuddy_oauth::is_intl_domain(account.domain.as_deref()) {
        "https://www.workbuddy.ai"
    } else {
        "https://copilot.tencent.com"
    }
}

fn app_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            if let Ok(output) = std::process::Command::new("/usr/libexec/PlistBuddy")
                .args([
                    "-c",
                    "Print :CFBundleShortVersionString",
                    "/Applications/WorkBuddy.app/Contents/Info.plist",
                ])
                .output()
            {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if output.status.success() && !version.is_empty() {
                    return version;
                }
            }
            "5.5.6".to_string()
        })
        .as_str()
}

/// 国际版客户端身份（与 agent2api 的 EDITION_INTL 一致）。
const INTL_PRODUCT: &str = "WorkBuddy AI";
const INTL_CLIENT_VERSION: &str = "5.5.2";

pub fn headers(account: &WorkbuddyAccount) -> BTreeMap<String, String> {
    let intl = crate::modules::workbuddy_oauth::is_intl_domain(account.domain.as_deref());
    let version = if intl { INTL_CLIENT_VERSION } else { app_version() };
    let product = if intl { INTL_PRODUCT } else { "WorkBuddy" };
    let base = chat_base(account);
    let mut headers = BTreeMap::from([
        (
            "Authorization".into(),
            format!("Bearer {}", account.access_token),
        ),
        (
            "User-Agent".into(),
            format!("WorkBuddy/{version} {product}/{version} CLI/2.137.1"),
        ),
        ("X-IDE-Name".into(), product.into()),
        ("X-IDE-Type".into(), "WorkBuddy".into()),
        ("X-IDE-Version".into(), version.into()),
        ("X-Product".into(), product.into()),
        ("X-Agent-Purpose".into(), "conversation".into()),
        (
            "X-Domain".into(),
            base.trim_start_matches("https://").into(),
        ),
        ("X-User-Id".into(), account.uid.clone().unwrap_or_default()),
        ("X-CodeBuddy-Request".into(), "1".into()),
        (
            "Origin".into(),
            if base.ends_with(".ai") {
                base
            } else {
                "https://www.codebuddy.cn"
            }
            .into(),
        ),
        ("Accept".into(), "application/json, text/plain, */*".into()),
    ]);
    if let Some(enterprise) = account.enterprise_id.as_ref().filter(|id| !id.is_empty()) {
        headers.insert("X-Enterprise-Id".into(), enterprise.clone());
        headers.insert("X-Tenant-Id".into(), enterprise.clone());
    }
    headers
}

/// 国际版不消耗积分的免费模型（agent2api `DEFAULT_FREE_MODELS`），按顺序试到一个成功为止。
const INTL_KEEPALIVE_MODELS: &[&str] = &["deepseek-v4.1-flash", "hy3", "hy4-preview", "hy4-preview-f"];

/// 国际版的每日积分挂在「每日活跃」上：用免费模型发一次最小对话，让账号当天算活跃。
/// 返回成功的模型名；国内版账号直接返回 None。
pub async fn keep_intl_account_active(account: &WorkbuddyAccount, proxy: &str) -> Result<Option<String>, String> {
    if !crate::modules::workbuddy_oauth::is_intl_domain(account.domain.as_deref()) {
        return Ok(None);
    }
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20));
    if !proxy.trim().is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut last_error = String::from("没有可用的免费模型");
    for model in INTL_KEEPALIVE_MODELS {
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut request = client
            .post(format!("{}/v2/chat/completions", chat_base(account)))
            .json(&serde_json::json!({
                "model": model, "stream": true, "max_tokens": 16,
                "messages": [
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "hi"},
                ],
            }));
        for (name, value) in headers(account) {
            request = request.header(name, value);
        }
        request = request
            .header("Accept", "text/event-stream")
            .header("X-Request-ID", &request_id)
            .header("X-Conversation-ID", &request_id)
            .header("X-Conversation-Request-ID", &request_id)
            .header("X-Conversation-Message-ID", &request_id)
            .header("X-Root-Request-ID", &request_id)
            .header("X-Session-ID", &request_id)
            .header("Referer", "https://www.workbuddy.ai/");
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                // 读完流：不读的请求上游可能不记活跃。
                if response.bytes().await.is_ok() {
                    return Ok(Some((*model).to_string()));
                }
                last_error = format!("{model} 响应读取失败");
            }
            Ok(response) => last_error = format!("{model} 返回 HTTP {}", response.status().as_u16()),
            Err(error) => last_error = format!("{model} 请求失败：{error}"),
        }
    }
    Err(format!("WorkBuddy 国际版活跃保活失败：{last_error}"))
}

fn credential_payload(account: &WorkbuddyAccount) -> Value {
    json!({"headers": headers(account), "baseUrl": chat_base(account)})
}

/// Read account-authorized models, not a hard-coded list of other vendors' models.
pub async fn fetch_models(id: &str, proxy: &str) -> Result<Vec<MultiModelDefinition>, String> {
    let account = current_account(id, false).await?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20));
    if !proxy.trim().is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let enterprise = account
        .enterprise_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("personal");
    // 国际版没有 /v2/enterprises/…/models（实测 404），模型目录在 /v3/config，结构相同（agents[cli].models + models）。
    let url = if crate::modules::workbuddy_oauth::is_intl_domain(account.domain.as_deref()) {
        format!("{}/v3/config", chat_base(&account))
    } else {
        format!("{}/v2/enterprises/{enterprise}/models", chat_base(&account))
    };
    let mut request = client.get(url);
    for (name, value) in headers(&account) {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("WorkBuddy 模型目录连接失败: {e}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| "WorkBuddy 模型目录返回非 JSON".to_string())?;
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
    if !status.is_success() || !matches!(code, 0 | 200) {
        return Err(format!(
            "WorkBuddy 模型目录失败 HTTP {} / code {code}: {}",
            status.as_u16(),
            body.get("message")
                .or_else(|| body.get("msg"))
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }
    parse_models(&body)
}

fn parse_models(body: &Value) -> Result<Vec<MultiModelDefinition>, String> {
    let data = body.get("data").unwrap_or(body);
    let allowed = data
        .get("agents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|agent| {
            agent
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.eq_ignore_ascii_case("cli"))
        })
        .and_then(|agent| agent.get("models"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
        });
    // 收费墙分组（国际版「Pro Only」）里的模型对免费号直接 400（11158 not allowed for user type），
    // 号池不列它们，免得请求落上去失败且不换号。
    let paywalled = data
        .get("modelTiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|tier| {
            tier.get("enabled").and_then(Value::as_bool) != Some(false)
                && tier.get("accessMode").and_then(Value::as_str) == Some("paywall")
        })
        .flat_map(|tier| tier.get("modelIds").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|id| id.as_str().map(str::to_string))
        .collect::<BTreeSet<_>>();
    let mut models = BTreeMap::new();
    for model in data
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = model
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| model.as_str())
        else {
            continue;
        };
        if id.is_empty() || paywalled.contains(id) || allowed.as_ref().is_some_and(|set| !set.contains(id)) {
            continue;
        }
        let mut capabilities = vec!["text".into()];
        if ["supportsImages", "supportsImage", "supportsVision"]
            .iter()
            .any(|key| model.get(key).and_then(Value::as_bool) == Some(true))
        {
            capabilities.push("vision".into());
        }
        if ["supportsThinking", "supportsReasoning"]
            .iter()
            .any(|key| model.get(key).and_then(Value::as_bool) == Some(true))
        {
            capabilities.push("reasoning".into());
        }
        let exposed = format!("workbuddy/{id}");
        models.insert(
            exposed.clone(),
            MultiModelDefinition {
                id: exposed,
                alias: String::new(),
                capabilities,
                max_input_tokens: max_input_tokens(model),
                max_output_tokens: super::model_capacity::declared(model).1,
                enabled: true,
            },
        );
    }
    if models.is_empty() {
        return Err("WorkBuddy 没有返回可用模型，未添加虚构模型".into());
    }
    Ok(models.into_values().collect())
}

// defaultLength is only a desktop compaction budget, not the model's maximum.
// Prefer its largest selectable budget, bounded by the upstream input ceiling.
fn max_input_tokens(model: &Value) -> Option<u32> {
    super::model_capacity::declared(model).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intl_config_catalog_skips_paywalled_and_media_models() {
        let body = json!({"code": 0, "data": {
            "agents": [{"name": "cli", "models": ["hy4flash-free", "gpt-6-luna"]}],
            "models": [
                {"id": "hy4flash-free", "supportsImages": true, "supportsReasoning": true, "maxInputTokens": 960000},
                {"id": "gpt-6-luna", "supportsImages": true},
                {"id": "hy-image-3.5", "tags": ["text-to-image"]}
            ],
            "modelTiers": [{"id": "gpt-pro-only", "accessMode": "paywall", "enabled": true, "modelIds": ["gpt-6-luna"]}]
        }});
        let ids = parse_models(&body).unwrap().into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids, vec!["workbuddy/hy4flash-free"]);
    }

    #[test]
    fn catalog_only_exposes_authorized_models_and_declared_capabilities() {
        let models = parse_models(&json!({"data": {"models": [
            {"id":"enabled", "supportsImages":true}, {"id":"other"}],
            "agents":[{"name":"cli", "models":["enabled"]}]}}))
        .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "workbuddy/enabled");
        assert_eq!(models[0].capabilities, vec!["text", "vision"]);
    }

    #[test]
    fn catalog_preserves_real_maximum_not_desktop_default_or_arbitrary_one_million() {
        let models = parse_models(&json!({"data":{"models":[
            {"id":"large","maxInputTokens":1000000,"maxOutputTokens":128000,
             "contextWindow":{"defaultLength":300000,"supportedLengths":[300000,600000,1000000]}},
            {"id":"bounded","maxInputTokens":960000,"maxOutputTokens":"64000",
             "contextWindow":{"defaultLength":300000,"supportedLengths":[300000,960000,1000000]}},
            {"id":"small","maxInputTokens":192000,"maxOutputTokens":64000},
            {"id":"unknown","contextWindow":{"defaultLength":8000}}
        ]}})).unwrap();
        let find = |id: &str| models.iter().find(|m| m.id == format!("workbuddy/{id}")).unwrap();
        assert_eq!(find("large").max_input_tokens, Some(1000000));
        assert_eq!(find("large").max_output_tokens, Some(128000));
        assert_eq!(find("bounded").max_input_tokens, Some(960000));
        assert_eq!(find("bounded").max_output_tokens, Some(64000));
        assert_eq!(find("small").max_input_tokens, Some(192000));
        assert_eq!(find("unknown").max_input_tokens, None);
    }

    #[test]
    fn credits_use_precise_active_resources_not_expired_packages() {
        let account: WorkbuddyAccount = serde_json::from_value(json!({
            "id":"test", "email":"test", "access_token":"test", "created_at":0, "last_used":0,
            "quota_raw":{"userResource":{"data":{"Response":{"Data":{"Accounts":[
                {"Status":0,"CycleCapacitySizePrecise":"500","CycleCapacityRemainPrecise":"499.97"},
                {"Status":3,"CycleCapacitySize":100,"CycleCapacityRemain":0},
                {"Status":1,"CycleCapacitySize":900,"CycleCapacityRemain":900}
            ]}}}}}
        })).unwrap();
        let bucket = credit_bucket(&account).unwrap();
        assert_eq!(bucket.label, "可用积分");
        assert_eq!(bucket.remaining, Some(499.97));
        assert_eq!(bucket.total, Some(600.0));
        assert_eq!(bucket.remaining_percent, 83);
    }

    #[tokio::test]
    async fn credential_bridge_rejects_unauthenticated_local_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let bridge = CredentialBridge { address: format!("http://{address}"), secret: "private-test-key".into() };
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            serve_credentials(socket, bridge).await.unwrap();
        });
        let mut socket = TcpStream::connect(address).await.unwrap();
        socket.write_all(b"GET /credentials/any-account HTTP/1.1\r\nHost: localhost\r\n\r\n").await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 401"));
        assert!(!response.contains("private-test-key"));
        server.await.unwrap();
    }
}
