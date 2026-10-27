//! Shared, provider-scoped metadata. Never infer an upstream limit from a
//! desktop compaction default, and never apply Anthropic limits to a relay.
use serde_json::Value;
use std::sync::OnceLock;

pub(super) fn positive_tokens(value: Option<&Value>) -> Option<u32> {
    let value = value?;
    let number = value.as_u64().or_else(|| value.as_str()?.trim().parse().ok())?;
    u32::try_from(number).ok().filter(|number| *number > 0)
}

pub(super) fn defaults(provider: &str, id: &str) -> (Option<u32>, Option<u32>) {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    let catalog = CATALOG.get_or_init(|| serde_json::from_str(include_str!(
        "../../../sidecars/cle-cliproxy/cdk/CLIProxyAPI/internal/registry/models/models.json"
    )).expect("bundled model metadata must be valid JSON"));
    let Some(model) = catalog.get(provider).and_then(Value::as_array)
        .and_then(|models| models.iter().find(|model| model.get("id").and_then(Value::as_str)
            .is_some_and(|model_id| model_id.eq_ignore_ascii_case(id)))) else {
        return (None, None);
    };
    declared(model)
}

/// Token fields used by Anthropic, OpenAI-compatible, Gemini and extension
/// catalogs. Use declared maxima, not defaultLength or a guessed model family.
pub(super) fn declared(model: &Value) -> (Option<u32>, Option<u32>) {
    let read = |keys: &[&str]| keys.iter().find_map(|key| positive_tokens(model.pointer(key)));
    let ceiling = read(&["/max_input_tokens", "/maxInputTokens", "/inputTokenLimit", "/input_token_limit",
        "/context_length", "/context_window", "/contextWindow", "/contextLength", "/max_context_length",
        "/tokenLimits/maxInputTokens", "/capabilities/limits/max_prompt_tokens",
        "/capabilities/limits/max_context_window_tokens", "/capabilities/maxInputTokens"]);
    let selectable = model.pointer("/contextWindow/supportedLengths")
        .and_then(Value::as_array).into_iter().flatten()
        .filter_map(|value| positive_tokens(Some(value)))
        .filter(|value| ceiling.is_none_or(|max| *value <= max)).max();
    (selectable.or(ceiling), read(&["/max_output_tokens", "/maxOutputTokens", "/max_tokens",
        "/max_completion_tokens", "/outputTokenLimit", "/output_token_limit",
        "/tokenLimits/maxOutputTokens", "/capabilities/limits/max_output_tokens", "/capabilities/maxOutputTokens"]))
}

/// Cloud Code's `maxTokens` is the context window. Its experiment/checkpointer
/// budgets describe the IDE's compaction policy, not the upstream model limit.
/// Keep this interpretation scoped to Antigravity; other APIs use similar
/// names for output limits.
pub(super) fn antigravity_declared(model: &Value) -> (Option<u32>, Option<u32>) {
    let (input, output) = declared(model);
    (input.or_else(|| positive_tokens(model.get("maxTokens"))), output)
}

pub(super) fn antigravity_catalog(value: &Value) -> std::collections::BTreeMap<String, (Option<u32>, Option<u32>)> {
    value.get("models").and_then(Value::as_object).into_iter().flatten()
        .map(|(id, model)| (id.clone(), antigravity_declared(model)))
        .collect()
}

/// Follow cursor fields on the same endpoint, never an upstream-supplied URL
/// that could send this account's Authorization header to another host.
pub(super) fn next_catalog_page(value: &Value) -> Option<(String, String)> {
    if let Some(token) = value.get("nextPageToken").and_then(Value::as_str).filter(|token| !token.is_empty()) {
        return Some(("pageToken".into(), token.into()));
    }
    if value.get("has_more").and_then(Value::as_bool) == Some(true) {
        let id = value.get("last_id").and_then(Value::as_str)
            .or_else(|| value.get("data")?.as_array()?.last()?.get("id")?.as_str())?;
        if !id.is_empty() { return Some(("after_id".into(), id.into())); }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn claude_maxima_are_current_and_channel_scoped() {
        for id in ["claude-sonnet-4-6", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] {
            assert_eq!(defaults("claude", id), (Some(1_000_000), Some(128_000)));
        }
        assert_ne!(defaults("antigravity", "claude-sonnet-4-6"), defaults("claude", "claude-sonnet-4-6"));
        assert_eq!(defaults("custom", "claude-opus-5-5"), (None, None));
        assert_eq!(defaults("claude", "claude-unknown"), (None, None));
    }
    #[test]
    fn gemini_catalog_uses_native_limit_fields_for_its_actual_channel() {
        assert_eq!(defaults("gemini", "gemini-2.5-pro").0, Some(1048576));
        assert_eq!(defaults("gemini-cli", "gemini-2.5-pro").0, Some(1048576));
        assert!(defaults("gemini-cli", "gemini-3-flash-preview").1.is_some());
        assert_eq!(defaults("custom", "gemini-2.5-pro"), (None, None));
    }
    #[test]
    fn catalog_fields_keep_maxima_and_ignore_client_defaults() {
        assert_eq!(declared(&json!({"max_input_tokens":1000000,"max_tokens":128000})), (Some(1000000), Some(128000)));
        assert_eq!(declared(&json!({"inputTokenLimit":"1048576","outputTokenLimit":65536})), (Some(1048576), Some(65536)));
        assert_eq!(declared(&json!({"contextWindow":{"defaultLength":8000}})), (None, None));
        assert_eq!(declared(&json!({"maxInputTokens":0,"maxOutputTokens":-1})), (None, None));
    }

    #[test]
    fn cloud_code_reads_actual_windows_without_guessing_from_names_or_compaction() {
        let catalog = antigravity_catalog(&json!({"models": {
            "claude-opus-5-5-medium": {"maxTokens":1000000,"maxOutputTokens":128000,
                "modelExperiments":{"max_token_limit":128000,"token_threshold":50000}},
            "claude-sonnet-4-6": {"maxTokens":250000,"maxOutputTokens":64000},
            "new-model": {"maxTokens":"2097152","maxOutputTokens":"65536"},
            "unknown": {"contextWindow":{"defaultLength":8000}},
            "invalid": {"maxTokens":0,"maxOutputTokens":-1}
        }}));
        assert_eq!(catalog["claude-opus-5-5-medium"], (Some(1000000),Some(128000)));
        assert_eq!(catalog["claude-sonnet-4-6"], (Some(250000),Some(64000)));
        assert_eq!(catalog["new-model"], (Some(2097152),Some(65536)));
        assert_eq!(catalog["unknown"], (None,None));
        assert_eq!(catalog["invalid"], (None,None));
        assert_eq!(declared(&json!({"maxTokens":1000000})), (None,None));
    }

    #[test]
    fn every_provider_shape_uses_real_ceilings_instead_of_low_desktop_defaults() {
        for model in [
            json!({"max_input_tokens":1000000,"max_output_tokens":128000}),
            json!({"inputTokenLimit":1000000,"outputTokenLimit":128000}),
            json!({"context_length":1000000,"max_completion_tokens":128000}),
            json!({"tokenLimits":{"maxInputTokens":"1000000","maxOutputTokens":"128000"}}),
            json!({"capabilities":{"limits":{"max_context_window_tokens":1000000,"max_output_tokens":128000}}}),
            json!({"capabilities":{"maxInputTokens":"1000000","maxOutputTokens":128000}}),
            json!({"maxInputTokens":1000000,"maxOutputTokens":128000,
                "contextWindow":{"defaultLength":8000,"supportedLengths":[8000,200000,1000000]}}),
        ] {
            assert_eq!(declared(&model), (Some(1000000), Some(128000)));
        }
        assert_eq!(declared(&json!({"maxInputTokens":960000,
            "contextWindow":{"supportedLengths":[300000,960000,1000000]}})).0, Some(960000));
        assert_eq!(declared(&json!({"id":"a-future-model"})), (None,None));
    }

    #[test]
    fn every_catalog_page_is_requested_without_following_external_urls() {
        assert_eq!(next_catalog_page(&json!({"nextPageToken":"page-2"})), Some(("pageToken".into(),"page-2".into())));
        assert_eq!(next_catalog_page(&json!({"has_more":true,"data":[{"id":"last-model"}]})), Some(("after_id".into(),"last-model".into())));
        assert_eq!(next_catalog_page(&json!({"has_more":true,"last_id":"cursor"})), Some(("after_id".into(),"cursor".into())));
        assert_eq!(next_catalog_page(&json!({"has_more":false,"next":"https://other.invalid/collect"})), None);
    }
}
