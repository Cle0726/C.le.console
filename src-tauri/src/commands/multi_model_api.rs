use crate::modules::multi_model_api::{
    self, MultiModelApiConfig, MultiModelApiState, MultiModelApiTestResult, MultiModelRepairReport,
};
use crate::modules::multi_model_xai::XaiOAuthStartResponse;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use url::Url;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelGenericOAuthStartRequest {
    pub authorization_url: String,
    pub client_id: String,
    #[serde(default)]
    pub redirect_uri: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub extra_authorize_params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelGenericOAuthStartResponse {
    pub auth_url: String,
    pub state: String,
    pub code_verifier: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelGenericOAuthExchangeRequest {
    pub provider: String,
    pub token_url: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub redirect_uri: String,
    #[serde(default)]
    pub callback_or_code: String,
    #[serde(default)]
    pub code_verifier: String,
    #[serde(default)]
    pub expected_state: String,
    #[serde(default)]
    pub extra_token_params: BTreeMap<String, String>,
}

#[tauri::command]
pub async fn multi_model_api_get_state() -> Result<MultiModelApiState, String> {
    multi_model_api::get_state().await
}

#[tauri::command]
pub async fn multi_model_api_save_config(
    config: MultiModelApiConfig,
) -> Result<MultiModelApiState, String> {
    multi_model_api::save_config(config).await
}

#[tauri::command]
pub async fn multi_model_api_set_enabled(enabled: bool) -> Result<MultiModelApiState, String> {
    multi_model_api::set_enabled(enabled).await
}

#[tauri::command]
pub async fn multi_model_api_sync_managed_accounts() -> Result<MultiModelApiState, String> {
    multi_model_api::sync_managed_accounts().await
}

#[tauri::command]
pub async fn multi_model_api_test_chat(
    model: Option<String>,
    prompt: Option<String>,
) -> Result<MultiModelApiTestResult, String> {
    multi_model_api::test_chat(model, prompt).await
}

#[tauri::command]
pub async fn multi_model_api_diagnose_and_repair(
    deep: Option<bool>,
) -> Result<MultiModelRepairReport, String> {
    multi_model_api::diagnose_and_repair(deep.unwrap_or(true)).await
}

#[tauri::command]
pub async fn multi_model_api_sync_local_gpt_bridges() -> Result<MultiModelApiState, String> {
    multi_model_api::sync_local_gpt_bridges().await
}

#[tauri::command]
pub async fn multi_model_api_xai_oauth_start() -> Result<XaiOAuthStartResponse, String> {
    multi_model_api::xai_oauth_start().await
}

#[tauri::command]
pub async fn multi_model_api_xai_oauth_complete(
    login_id: String,
) -> Result<MultiModelApiState, String> {
    multi_model_api::xai_oauth_complete(&login_id).await
}

#[tauri::command]
pub fn multi_model_api_xai_oauth_cancel(login_id: Option<String>) -> Result<(), String> {
    multi_model_api::xai_oauth_cancel(login_id.as_deref())
}

#[tauri::command]
pub async fn multi_model_api_import_local_xai_accounts() -> Result<MultiModelApiState, String> {
    multi_model_api::import_local_xai_accounts().await
}

#[tauri::command]
pub async fn multi_model_api_import_xai_accounts_json(
    json_content: String,
) -> Result<MultiModelApiState, String> {
    multi_model_api::import_xai_accounts_json(&json_content).await
}

#[tauri::command]
pub async fn multi_model_api_refresh_xai_accounts(
    force_credentials: Option<bool>,
) -> Result<MultiModelApiState, String> {
    multi_model_api::refresh_xai_accounts(force_credentials.unwrap_or(false)).await
}

#[tauri::command]
pub async fn multi_model_api_generic_oauth_start(
    request: MultiModelGenericOAuthStartRequest,
) -> Result<MultiModelGenericOAuthStartResponse, String> {
    let authorization_url = request.authorization_url.trim();
    let client_id = request.client_id.trim();
    let redirect_uri = request.redirect_uri.trim();
    if authorization_url.is_empty() {
        return Err("请填写 OAuth Authorization URL".into());
    }
    if client_id.is_empty() {
        return Err("请填写 OAuth Client ID".into());
    }
    if redirect_uri.is_empty() {
        return Err("请填写 OAuth Redirect URI".into());
    }

    let mut url = Url::parse(authorization_url)
        .map_err(|error| format!("Authorization URL 无效: {error}"))?;
    let state = random_url_token(24);
    let code_verifier = random_url_token(64);
    let code_challenge = pkce_challenge(&code_verifier);
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("response_type", "code");
        pairs.append_pair("client_id", client_id);
        pairs.append_pair("redirect_uri", redirect_uri);
        if !request.scope.trim().is_empty() {
            pairs.append_pair("scope", request.scope.trim());
        }
        pairs.append_pair("state", &state);
        pairs.append_pair("code_challenge", &code_challenge);
        pairs.append_pair("code_challenge_method", "S256");
        for (key, value) in request.extra_authorize_params {
            let key = key.trim();
            if !key.is_empty() {
                let value = value.trim();
                let value = if value == "__GENERATED_NONCE__" || value == "__GENERATED__" {
                    random_url_token(24)
                } else {
                    value.to_string()
                };
                pairs.append_pair(key, &value);
            }
        }
    }

    Ok(MultiModelGenericOAuthStartResponse {
        auth_url: url.to_string(),
        state,
        code_verifier,
    })
}

#[tauri::command]
pub async fn multi_model_api_generic_oauth_exchange(
    request: MultiModelGenericOAuthExchangeRequest,
) -> Result<Value, String> {
    let token_url = request.token_url.trim();
    let client_id = request.client_id.trim();
    let redirect_uri = request.redirect_uri.trim();
    let callback_or_code = request.callback_or_code.trim();
    let provider = normalize_generic_provider(&request.provider);
    if token_url.is_empty() {
        return Err("请填写 OAuth Token URL".into());
    }
    if client_id.is_empty() {
        return Err("请填写 OAuth Client ID".into());
    }
    if redirect_uri.is_empty() {
        return Err("请填写 OAuth Redirect URI".into());
    }
    if callback_or_code.is_empty() {
        return Err("请粘贴 OAuth 回调地址或 code".into());
    }
    Url::parse(token_url).map_err(|error| format!("Token URL 无效: {error}"))?;

    let is_callback_url =
        callback_or_code.starts_with("http://") || callback_or_code.starts_with("https://");
    let (code, state) = parse_callback_code(callback_or_code)?;
    if !request.expected_state.trim().is_empty() {
        if let Some(actual_state) = state.as_deref() {
            if actual_state != request.expected_state.trim() {
                return Err(
                    "OAuth state mismatch; please generate a new authorization link".into(),
                );
            }
        } else if is_callback_url {
            return Err("Callback URL is missing state; if the provider page only shows a code, paste only the code itself".into());
        }
    }

    let mut form = BTreeMap::<String, String>::new();
    form.insert("grant_type".into(), "authorization_code".into());
    form.insert("code".into(), code);
    form.insert("client_id".into(), client_id.into());
    form.insert("redirect_uri".into(), redirect_uri.into());
    if !request.client_secret.trim().is_empty() {
        form.insert("client_secret".into(), request.client_secret.trim().into());
    }
    if !request.code_verifier.trim().is_empty() {
        form.insert("code_verifier".into(), request.code_verifier.trim().into());
    }
    for (key, value) in request.extra_token_params {
        let key = key.trim();
        if !key.is_empty() {
            form.insert(key.into(), value.trim().into());
        }
    }

    let client = reqwest::Client::builder()
        .user_agent("C.le.console/1.1.4")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("创建 OAuth HTTP 客户端失败: {error}"))?;
    let response = client
        .post(token_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&form)
        .send()
        .await
        .map_err(|error| format!("请求 Token URL 失败: {error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取 OAuth token 响应失败: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "OAuth token 交换失败 HTTP {}: {}",
            status.as_u16(),
            trim_secret_response(&text)
        ));
    }
    let mut value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("OAuth token 响应不是 JSON: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "OAuth token 响应不是 JSON object".to_string())?;
    object
        .entry("type")
        .or_insert_with(|| Value::String(provider.clone()));
    object
        .entry("provider")
        .or_insert_with(|| Value::String(provider));
    object
        .entry("token_url")
        .or_insert_with(|| Value::String(token_url.into()));
    object
        .entry("redirect_uri")
        .or_insert_with(|| Value::String(redirect_uri.into()));
    if let Some(expires_in) = object.get("expires_in").and_then(Value::as_i64) {
        if expires_in > 0 && object.get("expired").is_none() && object.get("expires_at").is_none() {
            let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in);
            object.insert("expired".into(), json!(expires_at.to_rfc3339()));
        }
    }
    Ok(value)
}

fn random_url_token(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn normalize_generic_provider(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "grok" | "x.ai" | "xai" => "xai".into(),
        "anthropic" | "claude" => "claude".into(),
        "google" | "gemini" => "gemini".into(),
        "codex" => "codex".into(),
        "antigravity" => "antigravity".into(),
        "openai" | "" => "openai".into(),
        other => other
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' {
                    ch
                } else {
                    '-'
                }
            })
            .collect(),
    }
}

fn parse_callback_code(callback_or_code: &str) -> Result<(String, Option<String>), String> {
    let trimmed = callback_or_code.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = Url::parse(trimmed).map_err(|error| format!("回调地址无效: {error}"))?;
        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.to_string())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "回调地址缺少 code 参数".to_string())?;
        let state = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string());
        return Ok((code, state));
    }
    Ok((trimmed.to_string(), None))
}

fn trim_secret_response(text: &str) -> String {
    let compact = text.replace(['\r', '\n'], " ");
    if compact.len() > 800 {
        format!("{}...", &compact[..800])
    } else {
        compact
    }
}
