//! Doubao web chat accounts in the multi-model API pool: model catalog and
//! quota, read with the cookies of the account's browser login in C.le.
//! Endpoints and field meanings follow doubao-cli (MIT); chat itself is served
//! by cle-cliproxy (`doubao_web.go`).
use crate::modules::doubao_web;
use crate::modules::multi_model_api::{MultiModelAccountUsage, MultiModelDefinition, MultiModelUsageBucket};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const ORIGIN: &str = "https://www.doubao.com";
const BOT_ID: &str = "7338286299411103781";
const PROTOCOL_VERSION: &str = "2.32.10";
pub const AUTO_MODEL: &str = "doubao-web/auto";

#[derive(Clone, Default)]
struct CachedUsage {
    updated_at: Option<String>,
    status: String,
    status_reason: Option<String>,
    buckets: Vec<MultiModelUsageBucket>,
}

fn usage_cache() -> &'static Mutex<BTreeMap<String, CachedUsage>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, CachedUsage>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn random_digits() -> String {
    let n = uuid::Uuid::new_v4().as_u128() % 9_000_000_000_000_000 + 1_000_000_000_000_000;
    n.to_string()
}

async fn post_json(cookie: &str, path: &str, body: Value, proxy: &str) -> Result<Value, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
    if !proxy.trim().is_empty() {
        builder = builder.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|e| format!("代理地址无效：{e}"))?);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let (web_id, device_id) = (random_digits(), random_digits());
    let mut request = client
        .post(format!("{ORIGIN}{path}"))
        .query(&[
            ("aid", "1044603"), ("device_platform", "web"), ("samantha_web", "1"),
            ("pc_version", PROTOCOL_VERSION), ("doubao_pc_version", PROTOCOL_VERSION), ("version_code", "20800"),
            ("language", "zh"), ("region", "CN"), ("sys_region", "CN"),
            ("web_id", web_id.as_str()), ("device_id", device_id.as_str()),
        ])
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ORIGIN, ORIGIN)
        .header(reqwest::header::REFERER, format!("{ORIGIN}/chat/"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body);
    if let Some(csrf) = cookie.split(';').filter_map(|pair| pair.trim().split_once('=')).find(|(name, _)| *name == "passport_csrf_token").map(|(_, value)| value.to_string()) {
        request = request.header("X-Tt-Passport-Csrf-Token", csrf);
    }
    let response = request.send().await.map_err(|e| format!("豆包请求失败：{e}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("豆包登录已失效，请在 C.le 的豆包账号页重新登录".into());
    }
    if !status.is_success() {
        return Err(format!("豆包返回 HTTP {status}"));
    }
    response.json::<Value>().await.map_err(|e| format!("豆包返回内容无法解析：{e}"))
}

/// Models the account can use in Doubao's plain chat. "自动" (doubao-web/auto)
/// is always first; named models are listed only where the catalog says they
/// work in chat mode, so the pool never offers a model chat would reject.
pub(crate) fn models_from_catalog(response: &Value) -> Result<Vec<MultiModelDefinition>, String> {
    if response.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(format!("豆包模型目录读取失败：{}", response.get("msg").or_else(|| response.get("message")).and_then(Value::as_str).unwrap_or("未知错误")));
    }
    let config = response.pointer("/data/entry_list").and_then(Value::as_array)
        .and_then(|list| list.iter().find(|entry| entry.get("action_bar_key").and_then(Value::as_str) == Some("coco_deep_thinking")))
        .and_then(|entry| entry.get("active_switch_conf"));
    let mut models = vec![definition(AUTO_MODEL)];
    let Some(config) = config else { return Ok(models) };
    let key = |item: &Value| item.get("model_item_key").or_else(|| item.get("item_id"))
        .map(|value| value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string())).unwrap_or_default();
    let available = |item: &Value| item.get("disabled").and_then(Value::as_bool) != Some(true)
        && item.pointer("/subscribe_config/need_upgrade").and_then(Value::as_bool) != Some(true);
    let mut chat_keys = Vec::<String>::new();
    let shared = config.pointer("/menu_conf_v2/model_list/item_list").and_then(Value::as_array).cloned().unwrap_or_default();
    for mode in config.pointer("/menu_conf_v2/mode_list/item_list").and_then(Value::as_array).cloned().unwrap_or_default() {
        if mode.get("agent_mode").and_then(Value::as_i64) != Some(2) { continue; }
        let supports = mode.get("support_models").and_then(Value::as_array).cloned().unwrap_or_default();
        let supported = |item: &Value| supports.is_empty() || supports.iter().any(|model| {
            let id = model.get("model_item_key").or_else(|| model.get("item_id")).unwrap_or(model);
            id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string()) == key(item)
        });
        for item in mode.pointer("/model_list/item_list").and_then(Value::as_array).cloned().unwrap_or_default().iter()
            .chain(shared.iter().filter(|item| supported(item))) {
            let id = key(item);
            if !id.is_empty() && available(item) && !chat_keys.contains(&id) { chat_keys.push(id); }
        }
    }
    for id in chat_keys {
        // "9" is Doubao's own 自动, already offered as doubao-web/auto.
        if id != "9" { models.push(definition(&format!("doubao-web/{id}"))); }
    }
    Ok(models)
}

fn definition(id: &str) -> MultiModelDefinition {
    MultiModelDefinition { id: id.into(), alias: String::new(), capabilities: vec!["text".into()],
        max_input_tokens: None, max_output_tokens: None, enabled: true }
}

pub async fn fetch_models(account_id: &str, proxy: &str) -> Result<Vec<MultiModelDefinition>, String> {
    let cookie = doubao_web::pool_cookie_header(account_id).await?;
    let response = post_json(&cookie, "/alice/slot/action_bar_v3/brief_list", json!({"language_code": "zh", "bot_id": BOT_ID}), proxy).await?;
    models_from_catalog(&response)
}

pub(crate) fn buckets_from_summary(response: &Value) -> Result<(String, Vec<MultiModelUsageBucket>), String> {
    if response.get("code").and_then(Value::as_i64).is_some_and(|code| code != 0) || !response.get("data").is_some_and(Value::is_object) {
        return Err(format!("豆包额度读取失败：{}", response.get("msg").or_else(|| response.get("message")).and_then(Value::as_str).unwrap_or("没有额度数据")));
    }
    let data = &response["data"];
    let plan = data.pointer("/current_subscription/display/short_name").and_then(Value::as_str).unwrap_or("免费体验").to_string();
    let mut buckets = Vec::new();
    for (section, source) in [("window_limit_section", "个人"), ("enterprise_window_limit_section", "企业"), ("quota_package_section", "加油包"), ("incentive_quota_section", "奖励")] {
        let exhausted_section = data.pointer(&format!("/{section}/usage_exhausted")).and_then(Value::as_bool) == Some(true);
        for group in data.pointer(&format!("/{section}/window_limit_groups")).and_then(Value::as_array).cloned().unwrap_or_default() {
            let name = group.get("feature_group_name").or_else(|| group.get("feature_group")).and_then(Value::as_str).unwrap_or("额度");
            for item in group.get("window_limits").and_then(Value::as_array).cloned().unwrap_or_default() {
                let window = item.get("window_type").and_then(Value::as_i64).unwrap_or_default();
                let period = match window { 1 => "5 小时", 2 => "7 天", 3 => "订阅总量", 4 => "每月", _ => "周期" };
                let unlimited = window == 1 && item.pointer("/exemption/active").and_then(Value::as_bool) == Some(true);
                let used = item.get("used_percent").and_then(Value::as_f64).filter(|v| (0.0..=100.0).contains(v));
                let remaining = if unlimited { 100 } else if exhausted_section || used.is_some_and(|v| v >= 100.0) { 0 }
                    else { used.map(|v| (100.0 - v).round() as i32).unwrap_or(-1) };
                let end = if unlimited { item.pointer("/exemption/end_time") } else { item.get("end_time") };
                let reset_at = end.and_then(Value::as_i64).filter(|ms| *ms > 0)
                    .and_then(chrono::DateTime::from_timestamp_millis).map(|at| at.to_rfc3339());
                buckets.push(MultiModelUsageBucket {
                    id: format!("{section}:{name}:{window}"),
                    label: format!("{source} · {name} · {period}{}", if unlimited { "（不限）" } else { "" }),
                    remaining_percent: remaining,
                    remaining: item.get("total_amount").and_then(Value::as_f64).zip(item.get("used_amount").and_then(Value::as_f64)).map(|(total, used)| (total - used).max(0.0)),
                    total: item.get("total_amount").and_then(Value::as_f64),
                    reset_at,
                });
            }
        }
    }
    if buckets.is_empty() {
        // Free accounts get no public quota windows; Doubao says so in the chat reply when a model runs out.
        buckets.push(MultiModelUsageBucket { id: "plan".into(), label: format!("{plan} · 豆包未公开额度，用完时会在回复中提示"),
            remaining_percent: -1, remaining: None, total: None, reset_at: None });
    }
    Ok((plan, buckets))
}

pub async fn refresh_quota(account_id: &str, proxy: &str) -> Result<(), String> {
    let result = async {
        let cookie = doubao_web::pool_cookie_header(account_id).await?;
        let response = post_json(&cookie, "/alice/commerce/sale/subscription/quota/summary/", json!({"product_line": "membership"}), proxy).await?;
        buckets_from_summary(&response)
    }.await;
    let mut cache = usage_cache().lock().map_err(|_| "额度缓存不可用")?;
    let entry = cache.entry(account_id.to_string()).or_default();
    match result {
        Ok((_, buckets)) => {
            *entry = CachedUsage { updated_at: Some(chrono::Utc::now().to_rfc3339()), status: "normal".into(), status_reason: None, buckets };
            Ok(())
        }
        Err(error) => {
            entry.status = if error.contains("重新登录") { "login_required".into() } else { "error".into() };
            entry.status_reason = Some(error.clone());
            Err(error)
        }
    }
}

pub fn usage(account_id: &str, route_id: &str) -> Option<MultiModelAccountUsage> {
    let cached = usage_cache().lock().ok()?.get(account_id).cloned()?;
    Some(MultiModelAccountUsage { account_id: route_id.into(), updated_at: cached.updated_at, status: cached.status,
        status_reason: cached.status_reason, buckets: cached.buckets })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_lists_auto_and_only_chat_models() {
        let response = json!({"code": 0, "data": {"entry_list": [{"action_bar_key": "coco_deep_thinking", "active_switch_conf": {"menu_conf_v2": {
            "mode_list": {"item_list": [
                {"agent_mode": 1, "model_list": {"item_list": [{"model_item_key": "person-kimi", "name": "Kimi"}]}},
                {"agent_mode": 2, "support_models": ["seed-lite"], "model_list": {"item_list": [{"model_item_key": "9", "name": "自动"}]}}]},
            "model_list": {"item_list": [{"model_item_key": "seed-lite", "name": "Lite"}, {"model_item_key": "5", "name": "Pro", "subscribe_config": {"need_upgrade": true}},
                {"model_item_key": "person-glm", "name": "GLM"}]}}}}]}});
        let ids = models_from_catalog(&response).unwrap().into_iter().map(|m| m.id).collect::<Vec<_>>();
        assert_eq!(ids, vec!["doubao-web/auto", "doubao-web/seed-lite"]);
        assert_eq!(models_from_catalog(&json!({"code": 0, "data": {}})).unwrap().len(), 1);
        assert!(models_from_catalog(&json!({"code": 7, "msg": "no"})).is_err());
    }

    #[test]
    fn summary_buckets_and_free_plan() {
        let (plan, buckets) = buckets_from_summary(&json!({"code": 0, "data": {"current_subscription": {"display": {"short_name": "免费体验"}}}})).unwrap();
        assert_eq!(plan, "免费体验");
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].remaining_percent, -1);
        let (_, buckets) = buckets_from_summary(&json!({"code": 0, "data": {"window_limit_section": {"window_limit_groups": [{"feature_group_name": "深度思考",
            "window_limits": [{"window_type": 1, "used_percent": 30, "end_time": 1794741923046_i64}, {"window_type": 2, "used_percent": 100}]}]}}})).unwrap();
        assert_eq!(buckets.iter().map(|b| b.remaining_percent).collect::<Vec<_>>(), vec![70, 0]);
        assert!(buckets[0].reset_at.is_some());
        assert!(buckets_from_summary(&json!({"code": 1, "msg": "bad"})).is_err());
    }
}
