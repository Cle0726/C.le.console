use base64::Engine as _;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

const OIDC_DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
const OIDC_ISSUER: &str = "https://auth.x.ai";
const OIDC_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const OIDC_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const BILLING_URL: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const USER_URL: &str = "https://cli-chat-proxy.grok.com/v1/user?include=subscription";
const TASK_USAGE_URL: &str = "https://grok.com/rest/tasks/usage";
const FALLBACK_CLIENT_VERSION: &str = "0.2.93";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XaiOAuthStartResponse {
    pub login_id: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub user_code: String,
    pub expires_in: u64,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone)]
pub struct XaiOAuthCompleteResult {
    pub email: String,
    pub credential: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XaiQuotaBucket {
    pub id: String,
    pub label: String,
    pub used: Option<f64>,
    pub total: Option<f64>,
    pub remaining: Option<f64>,
    pub used_percent: Option<f64>,
    pub reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XaiAccountUsage {
    pub account_id: String,
    pub email: String,
    pub plan: Option<String>,
    pub status: String,
    pub status_reason: Option<String>,
    pub has_grok_code_access: Option<bool>,
    pub token_expires_at: Option<String>,
    pub updated_at: String,
    pub buckets: Vec<XaiQuotaBucket>,
}

#[derive(Debug, Clone)]
pub struct LocalXaiCredential {
    pub email: String,
    pub credential: Value,
    pub source_path: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
struct OidcDiscovery {
    device_authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    userinfo_endpoint: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: i64,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Clone)]
struct PendingDeviceLogin {
    device_code: String,
    token_endpoint: String,
    userinfo_endpoint: Option<String>,
    expires_at: i64,
    interval_seconds: u64,
}

static PENDING_LOGINS: LazyLock<Mutex<HashMap<String, PendingDeviceLogin>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_seconds() -> i64 {
    chrono::Utc::now().timestamp()
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(value)) => value.as_f64(),
        Some(Value::String(value)) => value.parse().ok(),
        Some(Value::Object(value)) => value.get("val").and_then(|item| number(Some(item))),
        _ => None,
    }
}

fn validate_xai_https(raw: &str, field: &str) -> Result<String, String> {
    let url = url::Url::parse(raw.trim()).map_err(|error| format!("{field} 地址无效: {error}"))?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if url.scheme() != "https" || (host != "x.ai" && !host.ends_with(".x.ai")) {
        return Err(format!("{field} 必须是 x.ai 官方 HTTPS 地址"));
    }
    Ok(url.to_string())
}

fn client(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(35))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy_url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy_url).map_err(|error| format!("xAI 代理地址无效: {error}"))?,
        );
    }
    builder
        .build()
        .map_err(|error| format!("创建 xAI HTTP 客户端失败: {error}"))
}

async fn response_json(response: reqwest::Response, label: &str) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取{label}响应失败: {error}"))?;
    if !status.is_success() {
        let detail = body
            .replace(['\r', '\n'], " ")
            .chars()
            .take(240)
            .collect::<String>();
        return Err(format!(
            "{label}返回 HTTP {}{}",
            status.as_u16(),
            if detail.is_empty() {
                String::new()
            } else {
                format!("：{detail}")
            }
        ));
    }
    serde_json::from_str(&body).map_err(|error| format!("解析{label}响应失败: {error}"))
}

async fn send_with_retry<F>(label: &str, mut build: F) -> Result<reqwest::Response, String>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    let mut last_error = None;
    for attempt in 1..=3_u64 {
        match build().send().await {
            Ok(response) => return Ok(response),
            Err(error) => {
                last_error = Some(error.to_string());
                if attempt < 3 {
                    tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
                }
            }
        }
    }
    Err(format!(
        "{label}请求失败: {}",
        last_error.unwrap_or_else(|| "未知传输错误".into())
    ))
}

pub async fn start_oauth(proxy_url: Option<&str>) -> Result<XaiOAuthStartResponse, String> {
    let client = client(proxy_url)?;
    let discovery: OidcDiscovery = serde_json::from_value(
        response_json(
            send_with_retry("xAI OIDC discovery", || {
                client
                    .get(OIDC_DISCOVERY_URL)
                    .header(ACCEPT, "application/json")
            })
            .await?,
            "xAI OIDC discovery",
        )
        .await?,
    )
    .map_err(|error| format!("xAI OIDC discovery 字段无效: {error}"))?;
    let device_endpoint = validate_xai_https(
        &discovery.device_authorization_endpoint,
        "device_authorization_endpoint",
    )?;
    let token_endpoint = validate_xai_https(&discovery.token_endpoint, "token_endpoint")?;
    let userinfo_endpoint = discovery
        .userinfo_endpoint
        .as_deref()
        .map(|value| validate_xai_https(value, "userinfo_endpoint"))
        .transpose()?;
    let device: DeviceAuthorization = serde_json::from_value(
        response_json(
            send_with_retry("xAI Device Flow", || {
                client
                    .post(&device_endpoint)
                    .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                    .header(ACCEPT, "application/json")
                    .form(&[("client_id", OIDC_CLIENT_ID), ("scope", OIDC_SCOPE)])
            })
            .await?,
            "xAI Device Flow",
        )
        .await?,
    )
    .map_err(|error| format!("xAI Device Flow 字段无效: {error}"))?;
    if device.device_code.trim().is_empty()
        || device.user_code.trim().is_empty()
        || device.verification_uri.trim().is_empty()
    {
        return Err("xAI Device Flow 响应缺少必要字段".into());
    }
    let login_id = uuid::Uuid::new_v4().to_string();
    let expires_in = device.expires_in.clamp(60, 30 * 60) as u64;
    let interval_seconds = device.interval.unwrap_or(5).max(5);
    let verification_uri = validate_xai_https(&device.verification_uri, "verification_uri")?;
    let verification_uri_complete = device
        .verification_uri_complete
        .as_deref()
        .map(|value| validate_xai_https(value, "verification_uri_complete"))
        .transpose()?
        .or_else(|| {
            let return_to = format!("/oauth2/device?user_code={}", device.user_code);
            Some(format!(
                "https://accounts.x.ai/sign-in?redirect=oauth2-provider&return_to={}&email=true",
                urlencoding::encode(&return_to)
            ))
        });
    PENDING_LOGINS
        .lock()
        .map_err(|_| "xAI OAuth 状态锁失败".to_string())?
        .insert(
            login_id.clone(),
            PendingDeviceLogin {
                device_code: device.device_code,
                token_endpoint,
                userinfo_endpoint,
                expires_at: now_seconds() + expires_in as i64,
                interval_seconds,
            },
        );
    Ok(XaiOAuthStartResponse {
        login_id,
        verification_uri,
        verification_uri_complete,
        user_code: device.user_code,
        expires_in,
        interval_seconds,
    })
}

fn pending_login(login_id: &str) -> Result<PendingDeviceLogin, String> {
    let state = PENDING_LOGINS
        .lock()
        .map_err(|_| "xAI OAuth 状态锁失败".to_string())?
        .get(login_id)
        .cloned()
        .ok_or_else(|| "xAI OAuth 会话不存在或已取消，请重新授权".to_string())?;
    if state.expires_at <= now_seconds() {
        let _ = PENDING_LOGINS
            .lock()
            .map(|mut values| values.remove(login_id));
        return Err("xAI OAuth 验证码已过期，请重新授权".into());
    }
    Ok(state)
}

fn decode_claims(token: Option<&str>) -> Value {
    token
        .and_then(|value| value.split('.').nth(1))
        .and_then(|payload| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload)
                .ok()
        })
        .and_then(|payload| serde_json::from_slice(&payload).ok())
        .unwrap_or_else(|| json!({}))
}

fn merge_objects(primary: Value, fallback: Value) -> Value {
    let mut merged = fallback.as_object().cloned().unwrap_or_default();
    if let Some(object) = primary.as_object() {
        merged.extend(object.clone());
    }
    Value::Object(merged)
}

pub async fn complete_oauth(
    login_id: &str,
    proxy_url: Option<&str>,
) -> Result<XaiOAuthCompleteResult, String> {
    let client = client(proxy_url)?;
    let mut interval = pending_login(login_id)?.interval_seconds;
    loop {
        let state = pending_login(login_id)?;
        let response = client
            .post(&state.token_endpoint)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(ACCEPT, "application/json")
            .form(&[
                ("grant_type", DEVICE_GRANT),
                ("device_code", state.device_code.as_str()),
                ("client_id", OIDC_CLIENT_ID),
            ])
            .send()
            .await
            .map_err(|error| format!("轮询 xAI OAuth token 失败: {error}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取 xAI OAuth token 响应失败: {error}"))?;
        if status.is_success() {
            let token: Value = serde_json::from_str(&body)
                .map_err(|error| format!("解析 xAI OAuth token 失败: {error}"))?;
            let access_token = text(token.get("access_token"))
                .ok_or_else(|| "xAI OAuth 未返回 access_token".to_string())?;
            let mut claims = merge_objects(
                decode_claims(token.get("id_token").and_then(Value::as_str)),
                decode_claims(Some(&access_token)),
            );
            if let Some(endpoint) = state.userinfo_endpoint.as_deref() {
                if let Ok(response) = client
                    .get(endpoint)
                    .header(AUTHORIZATION, format!("Bearer {access_token}"))
                    .header(ACCEPT, "application/json")
                    .send()
                    .await
                {
                    if response.status().is_success() {
                        if let Ok(userinfo) = response.json::<Value>().await {
                            claims = merge_objects(userinfo, claims);
                        }
                    }
                }
            }
            let email = text(claims.get("email"))
                .or_else(|| text(claims.get("preferred_username")))
                .unwrap_or_else(|| "Grok OAuth 账号".to_string());
            let expires_in = token
                .get("expires_in")
                .and_then(Value::as_i64)
                .unwrap_or(21_600)
                .max(60);
            let expires_at =
                (chrono::Utc::now() + chrono::Duration::seconds(expires_in)).to_rfc3339();
            let mut credential = Map::new();
            credential.insert("type".into(), Value::String("xai".into()));
            credential.insert("provider".into(), Value::String("xai".into()));
            credential.insert("auth_kind".into(), Value::String("oauth".into()));
            credential.insert("access_token".into(), Value::String(access_token));
            for key in ["refresh_token", "id_token", "token_type", "scope"] {
                if let Some(value) = token.get(key).cloned() {
                    credential.insert(key.into(), value);
                }
            }
            credential.insert("expires_in".into(), Value::Number(expires_in.into()));
            credential.insert("expired".into(), Value::String(expires_at));
            credential.insert("email".into(), Value::String(email.clone()));
            credential.insert("token_endpoint".into(), Value::String(state.token_endpoint));
            credential.insert("oidc_issuer".into(), Value::String(OIDC_ISSUER.into()));
            credential.insert(
                "oidc_client_id".into(),
                Value::String(OIDC_CLIENT_ID.into()),
            );
            for key in ["sub", "user_id", "principal_id", "team_id"] {
                if let Some(value) = claims.get(key).cloned() {
                    credential.insert(key.into(), value);
                }
            }
            PENDING_LOGINS
                .lock()
                .map_err(|_| "xAI OAuth 状态锁失败".to_string())?
                .remove(login_id);
            return Ok(XaiOAuthCompleteResult {
                email,
                credential: Value::Object(credential),
            });
        }
        let error: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
        match error.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => interval = interval.saturating_add(5),
            Some("access_denied") => return Err("xAI OAuth 授权已被拒绝".into()),
            Some("expired_token") => return Err("xAI OAuth 验证码已过期".into()),
            Some(code) => {
                return Err(format!(
                    "xAI OAuth 失败: {code}{}",
                    text(error.get("error_description"))
                        .map(|value| format!(" ({value})"))
                        .unwrap_or_default()
                ))
            }
            None => return Err(format!("xAI OAuth token 返回 HTTP {}", status.as_u16())),
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

pub fn cancel_oauth(login_id: Option<&str>) -> Result<(), String> {
    let mut pending = PENDING_LOGINS
        .lock()
        .map_err(|_| "xAI OAuth 状态锁失败".to_string())?;
    if let Some(login_id) = login_id.map(str::trim).filter(|value| !value.is_empty()) {
        pending.remove(login_id);
    } else {
        pending.clear();
    }
    Ok(())
}

fn first_text(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| text(object.get(*key)))
}

fn official_credential(entry: &Value) -> Option<Value> {
    let object = entry.as_object()?;
    let access_token = first_text(object, &["access_token", "accessToken", "key"]);
    let refresh_token = first_text(object, &["refresh_token", "refreshToken"]);
    if access_token.is_none() && refresh_token.is_none() {
        return None;
    }
    let mut credential = object.clone();
    credential.insert("type".into(), Value::String("xai".into()));
    credential.insert("provider".into(), Value::String("xai".into()));
    credential.insert("auth_kind".into(), Value::String("oauth".into()));
    if let Some(access_token) = access_token {
        credential.insert("access_token".into(), Value::String(access_token));
    }
    if let Some(refresh_token) = refresh_token {
        credential.insert("refresh_token".into(), Value::String(refresh_token));
    }
    if let Some(email) = first_text(object, &["email", "account", "username"]) {
        credential.insert("email".into(), Value::String(email));
    }
    if let Some(password) = first_text(object, &["account_password", "accountPassword", "password"])
    {
        // The password is migration/recovery metadata only. Runtime requests use
        // OAuth tokens and never send this value to the xAI API.
        credential.insert("account_password".into(), Value::String(password));
    }
    credential
        .entry("token_endpoint")
        .or_insert_with(|| Value::String("https://auth.x.ai/oauth2/token".into()));
    credential
        .entry("oidc_issuer")
        .or_insert_with(|| Value::String(OIDC_ISSUER.into()));
    credential
        .entry("oidc_client_id")
        .or_insert_with(|| Value::String(OIDC_CLIENT_ID.into()));
    if !credential.contains_key("expired") {
        if let Some(value) = object.get("expires_at").cloned() {
            credential.insert("expired".into(), value);
        }
    }
    Some(Value::Object(credential))
}

fn credential_from_nested_object(wrapper: &Map<String, Value>, nested: &Value) -> Option<Value> {
    let mut credential = official_credential(nested)?;
    let object = credential.as_object_mut()?;
    if !object.contains_key("email") {
        if let Some(email) = first_text(wrapper, &["email", "account", "username", "name"]) {
            object.insert("email".into(), Value::String(email));
        }
    }
    if !object.contains_key("account_password") {
        if let Some(password) = first_text(
            wrapper,
            &["account_password", "accountPassword", "password"],
        ) {
            object.insert("account_password".into(), Value::String(password));
        }
    }
    for (target, aliases) in [
        ("principal_id", &["principal_id", "principalId"][..]),
        ("user_id", &["user_id", "userId"][..]),
        ("team_id", &["team_id", "teamId"][..]),
        ("sub", &["sub"][..]),
    ] {
        if !object.contains_key(target) {
            if let Some(value) = first_text(wrapper, aliases) {
                object.insert(target.into(), Value::String(value));
            }
        }
    }
    Some(credential)
}

fn credentials_from_value(value: &Value, path: &std::path::Path) -> Vec<LocalXaiCredential> {
    let mut entries = Vec::new();
    if let Some(array) = value.as_array() {
        for item in array {
            entries.extend(credentials_from_value(item, path));
        }
        return entries;
    }
    if let Some(object) = value.as_object() {
        let registry_entries = object
            .iter()
            .filter(|(key, value)| key.starts_with("https://auth.x.ai::") && value.is_object())
            .collect::<Vec<_>>();
        if !registry_entries.is_empty() {
            for (_, entry) in registry_entries {
                if let Some(credential) = official_credential(entry) {
                    let email = text(credential.get("email"))
                        .unwrap_or_else(|| "本机 Grok CLI 账号".into());
                    entries.push(LocalXaiCredential {
                        email,
                        credential,
                        source_path: path.to_path_buf(),
                    });
                }
            }
            return entries;
        }
        if let Some(accounts) = object.get("accounts").and_then(Value::as_array) {
            for account in accounts {
                entries.extend(credentials_from_value(account, path));
            }
            return entries;
        }
        for key in ["credentials", "credential", "tokens", "oauth"] {
            if let Some(nested) = object.get(key) {
                if let Some(credential) = credential_from_nested_object(object, nested) {
                    let email =
                        text(credential.get("email")).unwrap_or_else(|| "Grok OAuth 账号".into());
                    entries.push(LocalXaiCredential {
                        email,
                        credential,
                        source_path: path.to_path_buf(),
                    });
                    return entries;
                }
            }
        }
    }
    if let Some(credential) = official_credential(value) {
        let email = text(credential.get("email")).unwrap_or_else(|| "本机 Grok CLI 账号".into());
        entries.push(LocalXaiCredential {
            email,
            credential,
            source_path: path.to_path_buf(),
        });
    }
    entries
}

fn split_account_line(line: &str) -> Option<Vec<String>> {
    for separator in ["----", "\t", "|", "::", ";", ","] {
        let parts = line
            .split(separator)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if parts.len() >= 2 {
            return Some(parts);
        }
    }
    None
}

fn strip_labeled_value(raw: &str) -> String {
    let trimmed = raw.trim();
    for prefix in [
        "refresh_token=",
        "refreshToken=",
        "rt=",
        "email=",
        "account=",
        "password=",
    ] {
        if trimmed
            .get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
        {
            return trimmed[prefix.len()..].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn credentials_from_account_lines(raw: &str, path: &std::path::Path) -> Vec<LocalXaiCredential> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim().trim_start_matches('\u{feff}');
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
                return None;
            }
            let mut parts = split_account_line(line)?;
            for part in &mut parts {
                *part = strip_labeled_value(part);
            }
            let email_index = parts.iter().position(|value| value.contains('@'))?;
            let refresh_index = parts
                .iter()
                .rposition(|value| {
                    let lower = value.to_ascii_lowercase();
                    lower.starts_with("rt_")
                        || lower.starts_with("refresh_token")
                        || lower.len() >= 32
                })
                .filter(|index| *index != email_index)?;
            let email = parts[email_index].trim().to_string();
            let refresh_token = parts[refresh_index].trim().to_string();
            if email.is_empty() || refresh_token.is_empty() {
                return None;
            }
            let password = parts
                .iter()
                .enumerate()
                .find(|(index, _)| *index != email_index && *index != refresh_index)
                .map(|(_, value)| value.trim())
                .filter(|value| !value.is_empty());
            let mut credential = Map::new();
            credential.insert("type".into(), Value::String("xai".into()));
            credential.insert("provider".into(), Value::String("xai".into()));
            credential.insert("auth_kind".into(), Value::String("oauth".into()));
            credential.insert("email".into(), Value::String(email.clone()));
            credential.insert("refresh_token".into(), Value::String(refresh_token));
            credential.insert(
                "token_endpoint".into(),
                Value::String("https://auth.x.ai/oauth2/token".into()),
            );
            credential.insert("oidc_issuer".into(), Value::String(OIDC_ISSUER.into()));
            credential.insert(
                "oidc_client_id".into(),
                Value::String(OIDC_CLIENT_ID.into()),
            );
            if let Some(password) = password {
                credential.insert(
                    "account_password".into(),
                    Value::String(password.to_string()),
                );
            }
            Some(LocalXaiCredential {
                email,
                credential: Value::Object(credential),
                source_path: path.to_path_buf(),
            })
        })
        .collect()
}

pub fn import_credentials_json(raw: &str) -> Result<Vec<LocalXaiCredential>, String> {
    let path = PathBuf::from("imported-grok-auth.json");
    let trimmed = raw.trim();
    let credentials = if trimmed.starts_with('{') || trimmed.starts_with('[') {
        let value: Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("解析 Grok OAuth / Sub2API JSON 失败: {error}"))?;
        credentials_from_value(&value, &path)
    } else {
        credentials_from_account_lines(raw, &PathBuf::from("imported-grok-accounts.txt"))
    };
    if credentials.is_empty() {
        return Err("未识别 Grok 账号；支持官方 ~/.grok/auth.json、Sub2API JSON、OAuth Token JSON，以及每行一个“账号----密码----refresh_token”记录".into());
    }
    Ok(credentials)
}

pub fn import_local_credentials() -> Result<Vec<LocalXaiCredential>, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let mut candidates = vec![home.join(".grok").join("auth.json")];
    if let Ok(grok_home) = std::env::var("GROK_HOME") {
        let path = PathBuf::from(grok_home).join("auth.json");
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    let mut inspected = Vec::new();
    for path in candidates {
        inspected.push(path.display().to_string());
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("解析本机 Grok auth.json 失败 {}: {error}", path.display()))?;
        for credential in credentials_from_value(&value, &path) {
            let identity = text(credential.credential.get("principal_id"))
                .or_else(|| text(credential.credential.get("user_id")))
                .or_else(|| text(credential.credential.get("email")))
                .unwrap_or_else(|| credential.email.clone())
                .to_ascii_lowercase();
            if seen.insert(identity) {
                result.push(credential);
            }
        }
    }
    if result.is_empty() {
        return Err(format!(
            "未发现可导入的 Grok CLI OAuth 登录态；已检查 {}",
            inspected.join("、")
        ));
    }
    Ok(result)
}

fn amount_triplet(value: &Value) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
    if let Some(items) = value.as_array() {
        return items.iter().find_map(amount_triplet);
    }
    let object = value.as_object()?;
    let total = number(
        object
            .get("total")
            .or_else(|| object.get("limit"))
            .or_else(|| object.get("cap"))
            .or_else(|| object.get("allocation"))
            .or_else(|| object.get("amount")),
    );
    let used = number(
        object
            .get("used")
            .or_else(|| object.get("spent"))
            .or_else(|| object.get("consumed"))
            .or_else(|| object.get("usage")),
    );
    let remaining = number(
        object
            .get("remaining")
            .or_else(|| object.get("balance"))
            .or_else(|| object.get("left")),
    );
    if total.is_none() && used.is_none() && remaining.is_none() {
        return object
            .get("bags")
            .or_else(|| object.get("items"))
            .and_then(amount_triplet);
    }
    let used = used.or_else(|| {
        total
            .zip(remaining)
            .map(|(total, remaining)| (total - remaining).max(0.0))
    });
    let remaining =
        remaining.or_else(|| total.zip(used).map(|(total, used)| (total - used).max(0.0)));
    Some((used, total, remaining))
}

fn percent(used: Option<f64>, total: Option<f64>) -> Option<f64> {
    match (used, total) {
        (Some(used), Some(total)) if total > 0.0 => {
            Some(((used.max(0.0) / total) * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    }
}

fn nested_number(value: &Value, key: &str) -> Option<f64> {
    match value {
        Value::Object(object) => object
            .get(key)
            .and_then(|value| number(Some(value)))
            .or_else(|| object.values().find_map(|value| nested_number(value, key))),
        Value::Array(items) => items.iter().find_map(|value| nested_number(value, key)),
        _ => None,
    }
}

fn active_subscription(value: &Value) -> Option<&Value> {
    let user = value
        .get("user")
        .filter(|value| value.is_object())
        .unwrap_or(value);
    user.get("subscription")
        .filter(|value| value.is_object())
        .or_else(|| {
            user.get("subscriptions")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find(|item| {
                            item.get("status")
                                .and_then(Value::as_str)
                                .is_some_and(|status| status.contains("ACTIVE"))
                        })
                        .or_else(|| items.first())
                })
        })
}

fn request_builder(
    client: &reqwest::Client,
    url: &str,
    access_token: &str,
) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header(ACCEPT, "application/json")
        .header("x-xai-token-auth", "xai-grok-cli")
        .header("x-grok-cli-version", FALLBACK_CLIENT_VERSION)
        .header("x-grok-client-version", FALLBACK_CLIENT_VERSION)
        .header("x-grok-client-surface", "grok-cli")
        .header("x-grok-client-identifier", "cle-console")
        .header(USER_AGENT, format!("grok-cli/{FALLBACK_CLIENT_VERSION}"))
}

async fn optional_json(request: reqwest::RequestBuilder) -> Option<Value> {
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

pub async fn query_usage(
    account_id: &str,
    account_name: &str,
    credential: &Value,
    proxy_url: Option<&str>,
) -> Result<XaiAccountUsage, String> {
    let access_token = text(credential.get("access_token"))
        .or_else(|| text(credential.get("key")))
        .ok_or_else(|| "Grok OAuth 凭据缺少 access_token".to_string())?;
    let client = client(proxy_url)?;
    let billing = response_json(
        send_with_retry("Grok 配额", || {
            request_builder(&client, BILLING_URL, &access_token)
        })
        .await?,
        "Grok 配额",
    )
    .await?;
    let user = optional_json(request_builder(&client, USER_URL, &access_token)).await;
    let task_usage = optional_json(request_builder(&client, TASK_USAGE_URL, &access_token)).await;
    let config = billing.get("config").unwrap_or(&billing);
    let period = config.get("currentPeriod").unwrap_or(&Value::Null);
    let reset_at = text(period.get("end")).or_else(|| text(config.get("billingPeriodEnd")));
    let subscription = user
        .as_ref()
        .and_then(active_subscription)
        .or_else(|| active_subscription(config));
    let plan = text(config.get("subscription_tier"))
        .or_else(|| text(config.get("subscriptionTier")))
        .or_else(|| subscription.and_then(|value| text(value.get("tier"))));
    let mut buckets = Vec::new();
    let credit_sources = [
        billing.get("credits"),
        billing.get("creditBalance"),
        billing.get("usage"),
        config.get("credits"),
        config.get("includedCredits"),
        config.get("subscriptionCredits"),
        config.get("weeklyCredits"),
        config.get("sharedPool"),
    ];
    let amounts = credit_sources
        .into_iter()
        .flatten()
        .find_map(amount_triplet);
    let explicit_percent = number(config.get("creditUsagePercent"));
    if let Some((used, total, remaining)) = amounts {
        buckets.push(XaiQuotaBucket {
            id: "weekly".into(),
            label: "每周总额度".into(),
            used,
            total,
            remaining,
            used_percent: explicit_percent.or_else(|| percent(used, total)),
            reset_at: reset_at.clone(),
        });
    } else if explicit_percent.is_some() {
        buckets.push(XaiQuotaBucket {
            id: "weekly".into(),
            label: "每周总额度".into(),
            used: None,
            total: None,
            remaining: None,
            used_percent: explicit_percent,
            reset_at: reset_at.clone(),
        });
    }
    if let Some(products) = config.get("productUsage").and_then(Value::as_array) {
        for (index, product) in products.iter().enumerate() {
            let label = text(product.get("product"))
                .or_else(|| text(product.get("name")))
                .or_else(|| text(product.get("productName")))
                .unwrap_or_else(|| format!("产品 {}", index + 1));
            let (used, total, remaining) = amount_triplet(product).unwrap_or((None, None, None));
            let used_percent = number(product.get("usagePercent"))
                .or_else(|| number(product.get("usedPercent")))
                .or_else(|| percent(used, total));
            buckets.push(XaiQuotaBucket {
                id: format!("product-{index}"),
                label,
                used,
                total,
                remaining,
                used_percent,
                reset_at: reset_at.clone(),
            });
        }
    }
    if let Some(task_usage) = task_usage.as_ref() {
        for (id, label, used_key, total_key) in [
            ("frequent", "高频任务", "frequentUsage", "frequentLimit"),
            (
                "occasional",
                "普通任务",
                "occasionalUsage",
                "occasionalLimit",
            ),
        ] {
            let used = nested_number(task_usage, used_key);
            let total = nested_number(task_usage, total_key);
            if used.is_some() || total.is_some() {
                let remaining = total.zip(used).map(|(total, used)| (total - used).max(0.0));
                buckets.push(XaiQuotaBucket {
                    id: id.into(),
                    label: label.into(),
                    used,
                    total,
                    remaining,
                    used_percent: percent(used, total),
                    reset_at: None,
                });
            }
        }
    }
    let user_payload = user
        .as_ref()
        .and_then(|value| value.get("user").or(Some(value)));
    let email = user_payload
        .and_then(|value| text(value.get("email")))
        .or_else(|| text(credential.get("email")))
        .unwrap_or_else(|| account_name.to_string());
    let has_grok_code_access = user_payload
        .and_then(|value| {
            value
                .get("hasGrokCodeAccess")
                .or_else(|| value.get("has_grok_code_access"))
        })
        .and_then(Value::as_bool);
    Ok(XaiAccountUsage {
        account_id: account_id.to_string(),
        email,
        plan,
        status: "normal".into(),
        status_reason: None,
        has_grok_code_access,
        token_expires_at: text(credential.get("expired"))
            .or_else(|| text(credential.get("expires_at"))),
        updated_at: chrono::Utc::now().to_rfc3339(),
        buckets,
    })
}

#[cfg(test)]
mod tests {
    use super::{credentials_from_account_lines, credentials_from_value, percent};
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn imports_official_registry_entry() {
        let input = json!({
            "https://auth.x.ai::client": {
                "key": "access",
                "refresh_token": "refresh",
                "email": "user@example.com"
            }
        });
        let values = credentials_from_value(&input, Path::new("auth.json"));
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].credential["access_token"], "access");
        assert_eq!(values[0].email, "user@example.com");
    }

    #[test]
    fn imports_sub2api_nested_refresh_token_and_password() {
        let input = json!({
            "type": "sub2api-data",
            "accounts": [{
                "name": "user@example.com",
                "platform": "grok",
                "type": "oauth",
                "credentials": {
                    "refresh_token": "rt_synthetic",
                    "account_password": "secret"
                }
            }]
        });
        let values = credentials_from_value(&input, Path::new("sub2api.json"));
        assert_eq!(values.len(), 1);
        assert_eq!(values[0].email, "user@example.com");
        assert_eq!(values[0].credential["refresh_token"], "rt_synthetic");
        assert_eq!(values[0].credential["account_password"], "secret");
    }

    #[test]
    fn imports_account_password_refresh_token_lines() {
        let input = "first@example.com----p@ss----rt_synthetic_one\nsecond@example.com|secret|rt_synthetic_two";
        let values = credentials_from_account_lines(input, Path::new("accounts.txt"));
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].email, "first@example.com");
        assert_eq!(values[0].credential["account_password"], "p@ss");
        assert_eq!(values[1].credential["refresh_token"], "rt_synthetic_two");
        assert!(values[0].credential.get("access_token").is_none());
    }

    #[test]
    fn quota_percent_is_clamped() {
        assert_eq!(percent(Some(25.0), Some(100.0)), Some(25.0));
        assert_eq!(percent(Some(150.0), Some(100.0)), Some(100.0));
    }
}
