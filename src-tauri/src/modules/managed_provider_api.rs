//! Native MIT CLIProxyAPIPlus adapters. OAuth ownership stays with C.le.
use crate::modules::{github_copilot_account, kiro_account, kiro_oauth};
use crate::modules::multi_model_api::{MultiModelDefinition, MultiModelAccountUsage, MultiModelUsageBucket};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use tokio::sync::Mutex;

pub fn supported(provider: &str) -> bool { matches!(provider, "kiro" | "github-copilot") }

pub async fn credential_payload(provider: &str, id: &str, force: bool) -> Result<Value, String> {
    // Serialize refresh for each managed account; rotated OAuth tokens must not race.
    static LOCKS: OnceLock<Mutex<BTreeMap<String, std::sync::Arc<Mutex<()>>>>> = OnceLock::new();
    let lock = LOCKS.get_or_init(Default::default).lock().await.entry(format!("{provider}:{id}"))
        .or_insert_with(|| std::sync::Arc::new(Mutex::new(()))).clone();
    let _guard = lock.lock().await;
    let now = chrono::Utc::now().timestamp();
    match provider {
        "kiro" => {
            let mut account = kiro_account::load_account(id).ok_or("Kiro 账号已删除")?;
            if force || account.expires_at.is_some_and(|at| at <= now + 120) {
                account = kiro_account::refresh_account_token(id).await?;
            }
            if account.access_token.trim().is_empty() || account.status.as_deref() == Some("login_required") {
                return Err("Kiro 登录已失效，请重新登录".into());
            }
            let arn = kiro_oauth::extract_profile_arn_from_account(&account).ok_or("Kiro 缺少 profile ARN，请刷新账号")?;
            let region = arn.split(':').nth(3).filter(|r| !r.is_empty()).unwrap_or("us-east-1");
            Ok(json!({"metadata": {
                "access_token": account.access_token, "profile_arn": arn,
                "api_region": region,
                "auth_method": if account.client_id.is_some() { "idc" } else { "social" },
                "expires_at": account.expires_at.and_then(|at| chrono::DateTime::from_timestamp(at, 0)).map(|at| at.to_rfc3339()),
            }}))
        }
        "github-copilot" => {
            let mut account = github_copilot_account::load_account(id).ok_or("Copilot 账号已删除")?;
            if force || account.copilot_expires_at.is_some_and(|at| at <= now + 120) {
                account = github_copilot_account::refresh_account_token(id).await?;
            }
            if account.github_access_token.trim().is_empty() || account.copilot_chat_enabled == Some(false) {
                return Err("Copilot 账号没有可用聊天权限，请重新登录或检查套餐".into());
            }
            Ok(json!({"metadata": {"access_token": account.github_access_token}}))
        }
        _ => Err("不支持的原生账号渠道".into()),
    }
}

pub async fn fetch_models(provider: &str, id: &str, proxy: &str) -> Result<Vec<MultiModelDefinition>, String> {
    let payload = credential_payload(provider, id, false).await?;
    let metadata = &payload["metadata"];
    let mut builder = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(8)).timeout(std::time::Duration::from_secs(25));
    if !proxy.trim().is_empty() { builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|e| e.to_string())?); }
    let client = builder.build().map_err(|e| e.to_string())?;
    let response = match provider {
        "kiro" => client.post("https://codewhisperer.us-east-1.amazonaws.com")
            .bearer_auth(metadata["access_token"].as_str().unwrap_or_default())
            .header("Content-Type", "application/x-amz-json-1.0")
            .header("x-amz-target", "AmazonCodeWhispererService.ListAvailableModels")
            .json(&json!({"origin":"AI_EDITOR", "profileArn":metadata["profile_arn"]})).send().await,
        "github-copilot" => {
            let account = github_copilot_account::load_account(id).ok_or("Copilot 账号已删除")?;
            client.get("https://api.githubcopilot.com/models").bearer_auth(account.copilot_token)
                .header("Editor-Version", "vscode/1.107.0").header("Editor-Plugin-Version", "copilot-chat/0.35.0")
                .header("Copilot-Integration-Id", "vscode-chat").header("User-Agent", "GitHubCopilotChat/0.35.0").send().await
        }
        _ => return Err("不支持的模型目录渠道".into()),
    }.map_err(|_| format!("{provider} 模型目录连接失败"))?;
    if !response.status().is_success() { return Err(format!("{provider} 模型目录 HTTP {}", response.status().as_u16())); }
    let body: Value = response.json().await.map_err(|_| "模型目录格式不正确")?;
    parse_models(provider, &body)
}

fn parse_models(provider: &str, body: &Value) -> Result<Vec<MultiModelDefinition>, String> {
    let entries = body.get(if provider == "kiro" { "models" } else { "data" }).and_then(Value::as_array).ok_or("上游未返回模型目录")?;
    let mut models = Vec::new();
    for item in entries {
        let Some(id) = item.get(if provider == "kiro" { "modelId" } else { "id" }).and_then(Value::as_str) else { continue };
        if id.trim().is_empty() || item.get("model_picker_enabled").and_then(Value::as_bool) == Some(false) { continue; }
        if provider == "github-copilot" && item.pointer("/capabilities/type").and_then(Value::as_str).is_some_and(|t| t != "chat") { continue; }
        let number = |paths: &[&str]| paths.iter().find_map(|p| item.pointer(p).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok())).filter(|n| *n > 0);
        let mut capabilities = vec!["text".into()];
        if item.pointer("/capabilities/supports/vision").and_then(Value::as_bool) == Some(true) { capabilities.push("vision".into()); }
        if item.pointer("/capabilities/supports/reasoning_effort").is_some_and(|v| v.as_bool() == Some(true) || v.as_array().is_some_and(|a| !a.is_empty())) { capabilities.push("reasoning".into()); }
        models.push(MultiModelDefinition { id:format!("{provider}/{id}"),alias:String::new(),capabilities,
            max_input_tokens:number(&["/tokenLimits/maxInputTokens", "/capabilities/limits/max_prompt_tokens", "/capabilities/limits/max_context_window_tokens"]),
            max_output_tokens:number(&["/tokenLimits/maxOutputTokens", "/capabilities/limits/max_output_tokens"]),enabled:true });
    }
    if models.is_empty() { return Err("上游未返回有聊天权限的模型".into()); }
    Ok(models)
}

pub async fn refresh_quota(provider: &str, id: &str) -> Result<(), String> {
    let error = match provider {
        "kiro" => kiro_account::refresh_account_token(id).await?.quota_query_last_error,
        "github-copilot" => github_copilot_account::refresh_account_token(id).await?.quota_query_last_error,
        _ => return Err("该渠道不支持额度刷新".into()),
    };
    if let Some(error) = error { return Err(error); } Ok(())
}

fn bucket(id: &str, total: f64, used: f64, reset: Option<String>) -> MultiModelUsageBucket {
    let remaining = (total - used).max(0.0);
    MultiModelUsageBucket {id:id.into(),label:id.into(),remaining_percent:if total>0.0 { (remaining / total * 100.0).clamp(0.0,100.0).round() as i32 } else {0},remaining:Some(remaining),total:Some(total),reset_at:reset}
}

pub fn usage(provider: &str, id: &str, route_id: &str) -> Option<MultiModelAccountUsage> {
    let (updated, status, reason, buckets) = match provider {
        "kiro" => {
            let a = kiro_account::load_account(id)?;
            let reset = a.usage_reset_at.and_then(|at| chrono::DateTime::from_timestamp(at,0)).map(|at| at.to_rfc3339());
            let mut buckets = Vec::new();
            if let Some(total) = a.credits_total { buckets.push(bucket("订阅额度", total,a.credits_used.unwrap_or(0.0),reset.clone())); }
            if let Some(total) = a.bonus_total { if total > 0.0 { buckets.push(bucket("赠送额度",total,a.bonus_used.unwrap_or(0.0),None)); } }
            (a.usage_updated_at,a.status.unwrap_or_else(|| "unknown".into()),a.quota_query_last_error.or(a.status_reason),buckets)
        }
        "github-copilot" => {
            let a = github_copilot_account::load_account(id)?;
            let mut buckets = Vec::new();
            if let Some(object) = a.copilot_quota_snapshots.as_ref().and_then(Value::as_object) {
                for (name, value) in object {
                    if value["unlimited"].as_bool() == Some(true) { continue; }
                    if let Some(total) = value["entitlement"].as_f64() {
                        let remaining = value["remaining"].as_f64().unwrap_or(0.0);
                        buckets.push(bucket(name,total,total-remaining,a.copilot_quota_reset_date.clone()));
                    }
                }
            }
            (a.usage_updated_at,if a.copilot_chat_enabled == Some(false) {"forbidden"} else {"normal"}.into(),a.quota_query_last_error,buckets)
        }
        _ => return None,
    };
    Some(MultiModelAccountUsage {account_id:route_id.into(),updated_at:updated.and_then(|at|chrono::DateTime::from_timestamp(at,0)).map(|at|at.to_rfc3339()),status,status_reason:reason,buckets})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_catalog_filters_nonchat_and_uses_upstream_capacity() {
        let models = parse_models("github-copilot", &json!({"data":[
            {"id":"live","capabilities":{"type":"chat","limits":{"max_prompt_tokens":222222,"max_output_tokens":33333},"supports":{"vision":true}}},
            {"id":"embed","capabilities":{"type":"embeddings"}},
            {"id":"hidden","model_picker_enabled":false}
        ]})).unwrap();
        assert_eq!(models.len(),1);assert_eq!(models[0].id,"github-copilot/live");
        assert_eq!(models[0].max_input_tokens,Some(222222));assert_eq!(models[0].max_output_tokens,Some(33333));
        assert!(models[0].capabilities.contains(&"vision".into()));
    }
}
