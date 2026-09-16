use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use crate::models::workbuddy::{WorkbuddyOAuthCompletePayload, WorkbuddyOAuthStartResponse};
use crate::modules::logger;

const WORKBUDDY_API_ENDPOINT: &str = "https://www.codebuddy.cn";
const WORKBUDDY_API_PREFIX: &str = "/v2/plugin";
const WORKBUDDY_PLATFORM: &str = "workbuddy";
const OAUTH_TIMEOUT_SECONDS: u64 = 600;
const OAUTH_POLL_INTERVAL_MS: u64 = 1500;

#[derive(Clone)]
struct PendingOAuthState {
    login_id: String,
    expires_at: i64,
    state: String,
    cancelled: bool,
}

lazy_static::lazy_static! {
    static ref PENDING_OAUTH_STATE: Arc<Mutex<Option<PendingOAuthState>>> = Arc::new(Mutex::new(None));
}

fn now_timestamp() -> i64 {
    chrono::Utc::now().timestamp()
}

fn generate_login_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..16).map(|_| rng.gen::<u8>()).collect();
    format!(
        "wb_{}",
        bytes
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    )
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        // Buddy rejects otherwise valid requests without a product User-Agent (code 10085).
        .user_agent(concat!(
            "WorkBuddy/",
            env!("CARGO_PKG_VERSION"),
            " C.le.console/",
            env!("CARGO_PKG_VERSION")
        ))
        .timeout(std::time::Duration::from_secs(30))
}

fn build_client() -> Result<reqwest::Client, String> {
    client_builder()
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败:{}", e))
}

fn normalize_non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

fn normalize_product_code(value: Option<&str>) -> String {
    normalize_non_empty(value).unwrap_or_else(|| "p_tcaca".to_string())
}

fn normalize_user_resource_status(status: &[i32]) -> Vec<i32> {
    let mut normalized: Vec<i32> = status.iter().copied().filter(|v| *v >= 0).collect();
    if normalized.is_empty() {
        return vec![0, 3];
    }
    normalized.sort_unstable();
    normalized.dedup();
    normalized
}

fn build_default_user_resource_time_range() -> (String, String) {
    let now = chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap());
    let begin = now.format("%Y-%m-%d %H:%M:%S").to_string();
    let end = (now + chrono::Duration::days(365 * 101))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string();
    (begin, end)
}

pub(crate) fn token_expires_at(data: &Value, access_token: &str, now: i64) -> Option<i64> {
    use base64::Engine;
    let number = |value: &Value| value.as_i64().or_else(|| value.as_str()?.parse().ok());
    let explicit = data
        .get("expiresAt")
        .or_else(|| data.get("expires_at"))
        .and_then(number);
    if let Some(expiry) = explicit.filter(|value| *value > 0) {
        return Some(if expiry > 10_000_000_000 {
            expiry / 1000
        } else {
            expiry
        });
    }
    // JWT is inspected only to schedule refresh, never to authenticate an account.
    if let Some(claims) = access_token
        .split('.')
        .nth(1)
        .and_then(|part| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(part.trim_end_matches('='))
                .ok()
        })
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        if let Some(expiry) = claims
            .get("exp")
            .and_then(number)
            .filter(|value| *value > 0)
        {
            return Some(expiry);
        }
    }
    data.get("expiresIn")
        .or_else(|| data.get("expires_in"))
        .and_then(number)
        .filter(|value| *value > 0)
        .and_then(|seconds| now.checked_add(seconds))
}

fn validate_api_body(body: &Value, http_status: u16, action: &str) -> Result<(), String> {
    let code = body.get("code").and_then(|value| value.as_i64());
    let message = body
        .get("message")
        .or_else(|| body.get("msg"))
        .and_then(|value| value.as_str())
        .unwrap_or("响应未包含错误说明");
    if !(200..300).contains(&http_status) {
        return Err(format!(
            "{}失败 (http={}): {}",
            action, http_status, message
        ));
    }
    if !matches!(code, Some(0 | 200)) {
        return Err(format!(
            "{}失败 (code={}): {}",
            action,
            code.unwrap_or(-1),
            message
        ));
    }
    if body.get("data").is_none_or(Value::is_null) {
        return Err(format!("{}响应缺少 data 字段", action));
    }
    Ok(())
}

async fn read_api_response(response: reqwest::Response, action: &str) -> Result<Value, String> {
    let status = response.status().as_u16();
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("解析{}响应失败 (http={}): {}", action, status, error))?;
    validate_api_body(&body, status, action)?;
    Ok(body)
}

#[derive(Debug, Default)]
pub(crate) struct RefreshDiagnostics {
    pub token_refreshed: bool,
    pub quota_refreshed: bool,
    pub token_error: Option<String>,
    pub quota_error: Option<String>,
}

impl RefreshDiagnostics {
    pub fn error_message(&self) -> Option<String> {
        let mut errors = Vec::new();
        if let Some(error) = &self.token_error {
            errors.push(format!("凭证刷新失败：{}", error));
        }
        if let Some(error) = &self.quota_error {
            errors.push(format!("额度查询失败（保留上次缓存）：{}", error));
        }
        if errors.is_empty() {
            return None;
        }
        if self.token_refreshed {
            errors.insert(0, "凭证已更新".to_string());
        }
        if self.quota_refreshed {
            errors.insert(0, "额度已更新".to_string());
        }
        Some(errors.join("；"))
    }
}

fn clear_pending_login(login_id: &str) -> Result<(), String> {
    let mut pending = PENDING_OAUTH_STATE
        .lock()
        .map_err(|_| "获取锁失败".to_string())?;
    if pending
        .as_ref()
        .map(|s| s.login_id == login_id)
        .unwrap_or(false)
    {
        *pending = None;
    }
    Ok(())
}

pub fn clear_pending_oauth_login(login_id: &str) -> Result<(), String> {
    clear_pending_login(login_id)
}

async fn start_login_with_platform(platform: &str) -> Result<WorkbuddyOAuthStartResponse, String> {
    let client = build_client()?;
    let url = format!(
        "{}{}/auth/state?platform={}",
        WORKBUDDY_API_ENDPOINT, WORKBUDDY_API_PREFIX, platform
    );

    logger::log_info(&format!("[WorkBuddy OAuth] 请求 auth/state: {}", url));

    let resp = client
        .post(&url)
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| format!("请求 auth/state 失败:{}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 auth/state 响应失败:{}", e))?;

    let data = body.get("data").ok_or_else(|| {
        let mut keys = body
            .as_object()
            .map(|obj| obj.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        keys.sort();
        format!("auth/state 响应缺少 data 字段: body_keys={:?}", keys)
    })?;

    let state = data
        .get("state")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "auth/state 响应缺少 state".to_string())?
        .to_string();

    let auth_url = data
        .get("authUrl")
        .or_else(|| data.get("auth_url"))
        .or_else(|| data.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let login_id = generate_login_id();

    let verification_uri = if auth_url.is_empty() {
        format!("{}/login?state={}", WORKBUDDY_API_ENDPOINT, state)
    } else {
        auth_url.clone()
    };

    {
        let mut pending = PENDING_OAUTH_STATE
            .lock()
            .map_err(|_| "获取锁失败".to_string())?;
        *pending = Some(PendingOAuthState {
            login_id: login_id.clone(),
            expires_at: now_timestamp() + OAUTH_TIMEOUT_SECONDS as i64,
            state: state.clone(),
            cancelled: false,
        });
    }

    logger::log_info(&format!(
        "[WorkBuddy OAuth] 登录已启动: login_id={}, state={}",
        login_id, state
    ));

    Ok(WorkbuddyOAuthStartResponse {
        login_id,
        verification_uri: verification_uri.clone(),
        verification_uri_complete: Some(verification_uri),
        expires_in: OAUTH_TIMEOUT_SECONDS,
        interval_seconds: OAUTH_POLL_INTERVAL_MS / 1000 + 1,
    })
}

pub async fn start_login() -> Result<WorkbuddyOAuthStartResponse, String> {
    start_login_with_platform(WORKBUDDY_PLATFORM).await
}

pub async fn complete_login(login_id: &str) -> Result<WorkbuddyOAuthCompletePayload, String> {
    let client = build_client()?;
    let start = now_timestamp();

    loop {
        let state_info = {
            let pending = PENDING_OAUTH_STATE
                .lock()
                .map_err(|_| "获取锁失败".to_string())?;
            match pending.as_ref() {
                None => return Err("没有待处理的登录请求".to_string()),
                Some(s) => {
                    if s.login_id != login_id {
                        return Err("login_id 不匹配".to_string());
                    }
                    if s.cancelled {
                        return Err("登录已取消".to_string());
                    }
                    if now_timestamp() > s.expires_at {
                        return Err("登录超时".to_string());
                    }
                    s.clone()
                }
            }
        };

        let url = format!(
            "{}{}/auth/token?state={}",
            WORKBUDDY_API_ENDPOINT, WORKBUDDY_API_PREFIX, state_info.state
        );

        match client.get(&url).send().await {
            Ok(resp) => {
                if let Ok(body) = resp.json::<Value>().await {
                    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);

                    if code == 0 || code == 200 {
                        if let Some(data) = body.get("data") {
                            let access_token = data
                                .get("accessToken")
                                .or_else(|| data.get("access_token"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();

                            if !access_token.is_empty() {
                                logger::log_info("[WorkBuddy OAuth] 获取 token 成功");

                                let refresh_token = data
                                    .get("refreshToken")
                                    .or_else(|| data.get("refresh_token"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                let expires_at =
                                    token_expires_at(data, &access_token, now_timestamp());

                                let domain = data
                                    .get("domain")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                let token_type = data
                                    .get("tokenType")
                                    .or_else(|| data.get("token_type"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());

                                let auth_raw = Some(data.clone());

                                let account_info = fetch_account_info(
                                    &client,
                                    &access_token,
                                    &state_info.state,
                                    domain.as_deref(),
                                )
                                .await;

                                let (
                                    uid,
                                    nickname,
                                    email,
                                    enterprise_id,
                                    enterprise_name,
                                    profile_raw,
                                ) = match account_info {
                                    Ok(info) => info,
                                    Err(e) => {
                                        logger::log_warn(&format!(
                                            "[WorkBuddy OAuth] 获取账号信息失败:{}",
                                            e
                                        ));
                                        return Err(format!("授权已完成，但无法读取 WorkBuddy 账号身份；未覆盖已保存账号：{}", e));
                                    }
                                };

                                return Ok(WorkbuddyOAuthCompletePayload {
                                    email,
                                    uid,
                                    nickname,
                                    enterprise_id,
                                    enterprise_name,
                                    access_token,
                                    refresh_token,
                                    token_type,
                                    expires_at,
                                    domain,
                                    plan_type: None,
                                    dosage_notify_code: None,
                                    dosage_notify_zh: None,
                                    dosage_notify_en: None,
                                    payment_type: None,
                                    quota_raw: None,
                                    auth_raw,
                                    profile_raw,
                                    usage_raw: None,
                                    status: Some("normal".to_string()),
                                    status_reason: None,
                                });
                            }
                        }
                    }
                }
            }
            Err(e) => {
                logger::log_warn(&format!("[WorkBuddy OAuth] 轮询 token 请求失败:{}", e));
            }
        }

        if now_timestamp() - start > OAUTH_TIMEOUT_SECONDS as i64 {
            let mut pending = PENDING_OAUTH_STATE
                .lock()
                .map_err(|_| "获取锁失败".to_string())?;
            *pending = None;
            return Err("登录超时".to_string());
        }

        tokio::time::sleep(std::time::Duration::from_millis(OAUTH_POLL_INTERVAL_MS)).await;
    }
}

pub fn cancel_login(login_id: Option<&str>) -> Result<(), String> {
    let mut pending = PENDING_OAUTH_STATE
        .lock()
        .map_err(|_| "获取锁失败".to_string())?;
    if let Some(state) = pending.as_mut() {
        if login_id.is_none() || login_id == Some(state.login_id.as_str()) {
            state.cancelled = true;
            *pending = None;
        }
    }
    Ok(())
}

async fn fetch_account_info(
    client: &reqwest::Client,
    access_token: &str,
    state: &str,
    domain: Option<&str>,
) -> Result<
    (
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<Value>,
    ),
    String,
> {
    let url = format!(
        "{}{}/login/account?state={}",
        WORKBUDDY_API_ENDPOINT, WORKBUDDY_API_PREFIX, state
    );

    let mut req = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token));

    if let Some(d) = domain {
        req = req.header("X-Domain", d);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 login/account 失败:{}", e))?;

    let body = read_api_response(resp, "读取 login/account").await?;

    let data = body.get("data").cloned().unwrap_or(json!({}));

    let uid = data
        .get("uid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let nickname = data
        .get("nickname")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let email = data
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let enterprise_id = data
        .get("enterpriseId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let enterprise_name = data
        .get("enterpriseName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let email_final = if email.is_empty() {
        nickname.clone().or_else(|| uid.clone()).unwrap_or_default()
    } else {
        email
    };

    Ok((
        uid,
        nickname,
        email_final,
        enterprise_id,
        enterprise_name,
        Some(data),
    ))
}

pub async fn refresh_token(
    access_token: &str,
    refresh_token: &str,
    domain: Option<&str>,
) -> Result<Value, String> {
    let client = build_client()?;
    let url = format!(
        "{}{}/auth/token/refresh",
        WORKBUDDY_API_ENDPOINT, WORKBUDDY_API_PREFIX
    );

    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("X-Refresh-Token", refresh_token)
        .json(&json!({}));

    if let Some(d) = domain {
        req = req.header("X-Domain", d);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("刷新 token 失败:{}", e))?;

    let body = read_api_response(resp, "刷新 token").await?;

    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 && code != 200 {
        let msg = body
            .get("message")
            .or_else(|| body.get("msg"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("刷新 token 失败 (code={}): {}", code, msg));
    }

    let data = body
        .get("data")
        .cloned()
        .ok_or_else(|| "刷新响应缺少 data 字段".to_string())?;
    if normalize_non_empty(
        data.get("accessToken")
            .or_else(|| data.get("access_token"))
            .and_then(Value::as_str),
    )
    .is_none()
    {
        return Err("刷新响应缺少有效 access token".to_string());
    }
    Ok(data)
}

pub async fn fetch_dosage_notify(
    access_token: &str,
    uid: Option<&str>,
    enterprise_id: Option<&str>,
    domain: Option<&str>,
) -> Result<Value, String> {
    let client = build_client()?;
    let url = format!(
        "{}/v2/billing/meter/get-dosage-notify",
        WORKBUDDY_API_ENDPOINT
    );

    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json");

    if let Some(u) = uid {
        req = req.header("X-User-Id", u);
    }
    if let Some(eid) = enterprise_id {
        req = req.header("X-Enterprise-Id", eid);
        req = req.header("X-Tenant-Id", eid);
    }
    if let Some(d) = domain {
        req = req.header("X-Domain", d);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 dosage notify 失败:{}", e))?;

    read_api_response(resp, "查询 dosage notify").await
}

pub async fn fetch_payment_type(
    access_token: &str,
    uid: Option<&str>,
    enterprise_id: Option<&str>,
    domain: Option<&str>,
) -> Result<Value, String> {
    let client = build_client()?;
    let url = format!(
        "{}/v2/billing/meter/get-payment-type",
        WORKBUDDY_API_ENDPOINT
    );

    let mut req = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json");

    if let Some(u) = uid {
        req = req.header("X-User-Id", u);
    }
    if let Some(eid) = enterprise_id {
        req = req.header("X-Enterprise-Id", eid);
        req = req.header("X-Tenant-Id", eid);
    }
    if let Some(d) = domain {
        req = req.header("X-Domain", d);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 payment type 失败:{}", e))?;

    read_api_response(resp, "查询 payment type").await
}

pub async fn fetch_user_resource_with_access_token(
    access_token: &str,
    uid: Option<&str>,
    enterprise_id: Option<&str>,
    domain: Option<&str>,
    product_code: &str,
    status: &[i32],
    package_end_time_range_begin: &str,
    package_end_time_range_end: &str,
    page_number: i32,
    page_size: i32,
) -> Result<Value, String> {
    let client = build_client()?;
    let url = format!(
        "{}/v2/billing/meter/get-user-resource",
        WORKBUDDY_API_ENDPOINT
    );

    let body = json!({
        "PageNumber": page_number,
        "PageSize": page_size,
        "ProductCode": product_code,
        "Status": status,
        "PackageEndTimeRangeBegin": package_end_time_range_begin,
        "PackageEndTimeRangeEnd": package_end_time_range_end
    });

    let mut req = client
        .post(&url)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json");

    if let Some(u) = uid {
        req = req.header("X-User-Id", u);
    }
    if let Some(eid) = enterprise_id {
        req = req.header("X-Enterprise-Id", eid);
        req = req.header("X-Tenant-Id", eid);
    }
    if let Some(d) = domain {
        req = req.header("X-Domain", d);
    }

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 user resource（Token）失败:{}", e))?;

    read_api_response(resp, "请求 user resource（Token）").await
}

async fn fetch_user_resource_with_access_token_default(
    access_token: &str,
    uid: Option<&str>,
    enterprise_id: Option<&str>,
    domain: Option<&str>,
) -> Result<Value, String> {
    let product_code = normalize_product_code(None);
    let status = normalize_user_resource_status(&[]);
    let (package_end_time_range_begin, package_end_time_range_end) =
        build_default_user_resource_time_range();
    fetch_user_resource_with_access_token(
        access_token,
        uid,
        enterprise_id,
        domain,
        product_code.as_str(),
        &status,
        package_end_time_range_begin.as_str(),
        package_end_time_range_end.as_str(),
        1,
        100,
    )
    .await
}

fn merge_quota_snapshot(
    cached: Option<&Value>,
    dosage: Option<&Value>,
    payment: Option<&Value>,
    resource: Option<&Value>,
) -> Option<Value> {
    let mut merged = cached
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, result) in [
        ("dosage", dosage),
        ("payment", payment),
        ("userResource", resource),
    ] {
        if let Some(result) = result {
            merged.insert(key.to_string(), result.clone());
        }
    }
    if merged.is_empty() {
        cached.cloned()
    } else {
        Some(Value::Object(merged))
    }
}

async fn refresh_payload_for_account_inner(
    account: &crate::models::workbuddy::WorkbuddyAccount,
    require_user_resource: bool,
) -> Result<(WorkbuddyOAuthCompletePayload, RefreshDiagnostics), String> {
    let mut diagnostics = RefreshDiagnostics::default();
    let mut new_access_token = account.access_token.clone();
    let mut new_refresh_token = account.refresh_token.clone();
    let mut new_expires_at = account.expires_at;
    let mut new_domain = account.domain.clone();

    if let Some(refresh_tk) = account.refresh_token.as_deref() {
        match refresh_token(&account.access_token, refresh_tk, account.domain.as_deref()).await {
            Ok(token_data) => {
                diagnostics.token_refreshed = true;
                new_access_token = token_data
                    .get("accessToken")
                    .or_else(|| token_data.get("access_token"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(&account.access_token)
                    .to_string();

                new_refresh_token = token_data
                    .get("refreshToken")
                    .or_else(|| token_data.get("refresh_token"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| account.refresh_token.clone());

                new_expires_at = token_expires_at(&token_data, &new_access_token, now_timestamp())
                    .or(account.expires_at);

                new_domain = token_data
                    .get("domain")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .or_else(|| account.domain.clone());
            }
            Err(e) => {
                logger::log_warn(&format!(
                    "[WorkBuddy] Token 刷新失败，将使用现有 token 查询配额:{}",
                    e
                ));
                diagnostics.token_error = Some(e);
            }
        }
    } else {
        diagnostics.token_error =
            Some("未保存 refresh token，无法刷新凭证；仍尝试查询额度".to_string());
    }
    new_expires_at = new_expires_at
        .or_else(|| token_expires_at(&Value::Null, &new_access_token, now_timestamp()));

    let resolved_email =
        normalize_non_empty(Some(account.email.as_str())).unwrap_or_else(|| account.email.clone());
    let resolved_uid = account.uid.clone();
    let resolved_nickname = account.nickname.clone();
    let resolved_enterprise_id = account.enterprise_id.clone();
    let resolved_enterprise_name = account.enterprise_name.clone();
    let resolved_profile_raw = account.profile_raw.clone();

    let dosage = fetch_dosage_notify(
        &new_access_token,
        resolved_uid.as_deref(),
        resolved_enterprise_id.as_deref(),
        new_domain.as_deref(),
    )
    .await
    .ok();

    let payment = fetch_payment_type(
        &new_access_token,
        resolved_uid.as_deref(),
        resolved_enterprise_id.as_deref(),
        new_domain.as_deref(),
    )
    .await
    .ok();

    logger::log_info(&format!(
        "[WorkBuddy][IDE Token] 尝试刷新 user_resource: has_uid={}, has_enterprise_id={}, has_domain={}",
        resolved_uid.is_some(),
        resolved_enterprise_id.is_some(),
        new_domain.is_some()
    ));
    let user_resource = match fetch_user_resource_with_access_token_default(
        new_access_token.as_str(),
        resolved_uid.as_deref(),
        resolved_enterprise_id.as_deref(),
        new_domain.as_deref(),
    )
    .await
    {
        Ok(payload) => {
            diagnostics.quota_refreshed = true;
            logger::log_info("[WorkBuddy][IDE Token] 刷新 user_resource 成功");
            Some(payload)
        }
        Err(err) => {
            logger::log_warn(&format!(
                "[WorkBuddy][IDE Token] 刷新 user_resource 失败:{}",
                err
            ));
            diagnostics.quota_error = Some(err.clone());
            if require_user_resource {
                return Err(
                    "使用 IDE token 刷新 user_resource 失败，无法获取资源包配额".to_string()
                );
            }
            None
        }
    };

    let dosage_data = dosage.as_ref().and_then(|v| v.get("data"));
    let dosage_notify_code = dosage_data
        .and_then(|d| d.get("dosageNotifyCode"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => v.to_string(),
        });
    let dosage_notify_zh = dosage_data
        .and_then(|d| d.get("dosageNotifyZh"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let dosage_notify_en = dosage_data
        .and_then(|d| d.get("dosageNotifyEn"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let payment_data = payment.as_ref().and_then(|v| v.get("data"));
    let payment_type = payment_data
        .and_then(|d| {
            d.as_str().map(|s| s.to_string()).or_else(|| {
                d.get("paymentType")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
        })
        .or_else(|| account.payment_type.clone());

    let quota_raw = merge_quota_snapshot(
        account.quota_raw.as_ref(),
        dosage.as_ref(),
        payment.as_ref(),
        user_resource.as_ref(),
    );

    let final_email =
        normalize_non_empty(Some(resolved_email.as_str())).unwrap_or_else(|| account.email.clone());

    Ok((
        WorkbuddyOAuthCompletePayload {
            email: final_email,
            uid: resolved_uid,
            nickname: resolved_nickname,
            enterprise_id: resolved_enterprise_id,
            enterprise_name: resolved_enterprise_name,
            access_token: new_access_token,
            refresh_token: new_refresh_token,
            token_type: account.token_type.clone(),
            expires_at: new_expires_at,
            domain: new_domain,
            plan_type: account.plan_type.clone(),
            dosage_notify_code,
            dosage_notify_zh,
            dosage_notify_en,
            payment_type,
            quota_raw,
            auth_raw: account.auth_raw.clone(),
            profile_raw: resolved_profile_raw,
            usage_raw: user_resource.or_else(|| account.usage_raw.clone()),
            status: account.status.clone(),
            status_reason: account.status_reason.clone(),
        },
        diagnostics,
    ))
}

pub(crate) async fn refresh_payload_for_account(
    account: &crate::models::workbuddy::WorkbuddyAccount,
) -> Result<(WorkbuddyOAuthCompletePayload, RefreshDiagnostics), String> {
    refresh_payload_for_account_inner(account, false).await
}

pub async fn build_payload_from_token(
    access_token: &str,
) -> Result<WorkbuddyOAuthCompletePayload, String> {
    let client = build_client()?;

    let url = format!(
        "{}{}/accounts",
        WORKBUDDY_API_ENDPOINT, WORKBUDDY_API_PREFIX
    );

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| format!("请求 accounts 失败: {}", e))?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 accounts 响应失败:{}", e))?;

    let accounts = body
        .get("data")
        .and_then(|d| d.get("accounts"))
        .and_then(|a| a.as_array());

    let account_data = accounts
        .and_then(|arr| {
            arr.iter().find(|a| {
                a.get("lastLogin")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
        })
        .or_else(|| accounts.and_then(|arr| arr.first()))
        .cloned()
        .unwrap_or(json!({}));

    let uid = account_data
        .get("uid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let nickname = account_data
        .get("nickname")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let email = account_data
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let enterprise_id = account_data
        .get("enterpriseId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let enterprise_name = account_data
        .get("enterpriseName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let dosage = fetch_dosage_notify(access_token, uid.as_deref(), enterprise_id.as_deref(), None)
        .await
        .ok();

    let payment = fetch_payment_type(access_token, uid.as_deref(), enterprise_id.as_deref(), None)
        .await
        .ok();

    let user_resource = fetch_user_resource_with_access_token_default(
        access_token,
        uid.as_deref(),
        enterprise_id.as_deref(),
        None,
    )
    .await
    .ok();

    let dosage_data = dosage.as_ref().and_then(|v| v.get("data"));
    let dosage_notify_code = dosage_data
        .and_then(|d| d.get("dosageNotifyCode"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => v.to_string(),
        });
    let dosage_notify_zh = dosage_data
        .and_then(|d| d.get("dosageNotifyZh"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let dosage_notify_en = dosage_data
        .and_then(|d| d.get("dosageNotifyEn"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let payment_data = payment.as_ref().and_then(|v| v.get("data"));
    let payment_type = payment_data.and_then(|d| {
        d.as_str().map(|s| s.to_string()).or_else(|| {
            d.get("paymentType")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
    });

    let mut combined_quota = serde_json::Map::new();
    if let Some(payload) = dosage.as_ref() {
        combined_quota.insert("dosage".to_string(), payload.clone());
    }
    if let Some(payload) = payment.as_ref() {
        combined_quota.insert("payment".to_string(), payload.clone());
    }
    if let Some(payload) = user_resource.as_ref() {
        combined_quota.insert("userResource".to_string(), payload.clone());
    }
    let quota_raw = if combined_quota.is_empty() {
        None
    } else {
        Some(Value::Object(combined_quota))
    };

    let email_final = if email.is_empty() {
        nickname
            .clone()
            .or_else(|| uid.clone())
            .unwrap_or_else(|| "unknown".to_string())
    } else {
        email
    };

    Ok(WorkbuddyOAuthCompletePayload {
        email: email_final,
        uid,
        nickname,
        enterprise_id,
        enterprise_name,
        access_token: access_token.to_string(),
        refresh_token: None,
        token_type: Some("Bearer".to_string()),
        expires_at: token_expires_at(&Value::Null, access_token, now_timestamp()),
        domain: None,
        plan_type: None,
        dosage_notify_code,
        dosage_notify_zh,
        dosage_notify_en,
        payment_type,
        quota_raw,
        auth_raw: None,
        profile_raw: Some(account_data),
        usage_raw: user_resource,
        status: Some("normal".to_string()),
        status_reason: None,
    })
}

#[cfg(test)]
mod management_tests {
    use super::*;

    #[test]
    fn expiry_accepts_seconds_milliseconds_and_expires_in() {
        assert_eq!(
            token_expires_at(&json!({"expiresAt": 1_800_000_000}), "opaque", 100),
            Some(1_800_000_000)
        );
        assert_eq!(
            token_expires_at(&json!({"expires_at": "1800000000000"}), "opaque", 100),
            Some(1_800_000_000)
        );
        assert_eq!(
            token_expires_at(&json!({"expiresIn": 3600}), "opaque", 100),
            Some(3700)
        );
        assert_eq!(
            token_expires_at(&json!({"expires_in": -1}), "opaque", 100),
            None
        );
    }

    #[test]
    fn expiry_uses_jwt_only_for_scheduling() {
        use base64::Engine;
        let claims =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"exp":1800000000}"#);
        let token = format!("header.{}.unsigned", claims);
        assert_eq!(
            token_expires_at(&Value::Null, &token, 100),
            Some(1_800_000_000)
        );
        assert_eq!(token_expires_at(&Value::Null, "broken.jwt", 100), None);
    }

    #[test]
    fn quota_failure_preserves_packages_and_partial_success_is_not_full_success() {
        let cached = json!({"userResource": {"data": {"Accounts": [1]}}, "dosage": "old"});
        let dosage = json!({"code": 0, "data": {"dosageNotifyCode": 0}});
        let merged = merge_quota_snapshot(Some(&cached), Some(&dosage), None, None).unwrap();
        assert_eq!(merged["userResource"], cached["userResource"]);
        assert_eq!(merged["dosage"], dosage);
        let diagnostics = RefreshDiagnostics {
            token_refreshed: true,
            quota_error: Some("http=403".into()),
            ..Default::default()
        };
        assert!(diagnostics
            .error_message()
            .unwrap()
            .contains("额度查询失败"));
        assert!(RefreshDiagnostics {
            token_refreshed: true,
            quota_refreshed: true,
            ..Default::default()
        }
        .error_message()
        .is_none());
    }

    #[test]
    fn rejects_http_business_and_missing_data_errors() {
        assert!(validate_api_body(&json!({"code": 0, "data": {}}), 200, "测试").is_ok());
        assert!(validate_api_body(
            &json!({"code": 10085, "message": "请求不合法"}),
            403,
            "测试"
        )
        .unwrap_err()
        .contains("http=403"));
        assert!(validate_api_body(&json!({"code": 401, "data": {}}), 200, "测试").is_err());
        assert!(validate_api_body(&json!({"code": 0, "data": null}), 200, "测试").is_err());
        assert!(validate_api_body(&json!({"data": {}}), 200, "测试").is_err());
    }

    #[tokio::test]
    async fn client_sends_product_user_agent() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_string();
        let worker = std::thread::spawn(move || {
            let request = server
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap()
                .unwrap();
            let agent = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("User-Agent"))
                .map(|header| header.value.to_string())
                .unwrap_or_default();
            request
                .respond(tiny_http::Response::from_string(r#"{"code":0,"data":{}}"#))
                .unwrap();
            agent
        });
        // Only this loopback test bypasses inherited proxies; production routing is unchanged.
        let response = client_builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{}", address))
            .send()
            .await
            .unwrap();
        read_api_response(response, "本地测试").await.unwrap();
        let agent = worker.join().unwrap();
        assert!(agent.starts_with("WorkBuddy/"));
        assert!(agent.contains("C.le.console/"));
    }

    #[tokio::test]
    #[ignore = "read-only live account verification; explicitly supply WORKBUDDY_LIVE_ACCOUNT_FILE"]
    async fn live_workbuddy_quota_and_checkin_smoke() {
        let path =
            std::env::var("WORKBUDDY_LIVE_ACCOUNT_FILE").expect("explicit account path required");
        let account: crate::models::workbuddy::WorkbuddyAccount =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let quota = fetch_user_resource_with_access_token_default(
            &account.access_token,
            account.uid.as_deref(),
            account.enterprise_id.as_deref(),
            account.domain.as_deref(),
        )
        .await
        .unwrap();
        let data = &quota["data"]["Response"]["Data"];
        let accounts = data["Accounts"]
            .as_array()
            .expect("official resource account array");
        println!(
            "live WorkBuddy quota: http/business success; {} resource packages",
            accounts.len()
        );
        let status = crate::modules::codebuddy_cn_oauth::get_checkin_status(
            &account.access_token,
            account.uid.as_deref(),
            account.enterprise_id.as_deref(),
            account.domain.as_deref(),
        )
        .await
        .unwrap();
        println!(
            "live WorkBuddy daily credits: active={}, today_checked_in={}",
            status.active, status.today_checked_in
        );
    }
}
