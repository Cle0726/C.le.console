use serde_json::Value;

pub const DEFAULT_HOST: &str = "gpt-6-luna";
const FALLBACKS: [&str; 3] = [DEFAULT_HOST, "gpt-5.6-terra", "gpt-6-sol"];

pub fn candidates(configured: Option<&str>) -> Vec<String> {
    let mut result = Vec::new();
    if let Some(model) = configured
        .map(str::trim)
        .filter(|v| v.to_ascii_lowercase().starts_with("gpt-"))
    {
        result.push(model.to_string());
    }
    for model in FALLBACKS {
        if !result.iter().any(|item| item.eq_ignore_ascii_case(model)) {
            result.push(model.to_string());
        }
    }
    result
}

pub fn is_unsupported(status: u16, body: &str) -> bool {
    let body = body.to_ascii_lowercase();
    status == 400
        && (body.contains("model_not_found") || body.contains("is not supported when using codex"))
}

pub fn with_model(body: &[u8], model: &str) -> Result<Vec<u8>, String> {
    let mut value: Value =
        serde_json::from_slice(body).map_err(|e| format!("解析生图请求失败: {e}"))?;
    let object = value.as_object_mut().ok_or("生图请求必须是 JSON 对象")?;
    object.insert("model".into(), Value::String(model.to_string()));
    serde_json::to_vec(&value).map_err(|e| format!("序列化生图请求失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_and_custom_models_are_ordered_and_deduplicated() {
        assert_eq!(
            candidates(None),
            ["gpt-6-luna", "gpt-5.6-terra", "gpt-6-sol"]
        );
        assert_eq!(
            candidates(Some(" gpt-6-sol ")),
            ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra"]
        );
        assert_eq!(candidates(Some("other")), candidates(None));
    }
    #[test]
    fn only_the_specific_400_error_triggers_fallback() {
        assert!(is_unsupported(400, "{\"code\":\"model_not_found\"}"));
        assert!(is_unsupported(
            400,
            "is not supported when using Codex with a ChatGPT account"
        ));
        assert!(!is_unsupported(429, "model_not_found"));
        assert!(!is_unsupported(400, "image_generation_not_enabled"));
        let input = br#"{"model":"gpt-6-luna","input":["unchanged"],"tools":[{"type":"image_generation"}]}"#;
        let value: Value =
            serde_json::from_slice(&with_model(input, "gpt-5.6-terra").unwrap()).unwrap();
        assert_eq!(value["model"], "gpt-5.6-terra");
        assert_eq!(value["input"][0], "unchanged");
        assert_eq!(value["tools"][0]["type"], "image_generation");
    }
}
