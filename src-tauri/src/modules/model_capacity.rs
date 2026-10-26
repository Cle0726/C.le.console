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
    let catalog = CATALOG.get_or_init(|| serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../sidecars/cle-cliproxy/cdk/CLIProxyAPI/internal/registry/models/models.json"
    ))).expect("bundled model metadata must be valid JSON"));
    let Some(model) = catalog.get(provider).and_then(Value::as_array)
        .and_then(|models| models.iter().find(|model| model.get("id").and_then(Value::as_str)
            .is_some_and(|model_id| model_id.eq_ignore_ascii_case(id)))) else {
        return (None, None);
    };
    (positive_tokens(model.get("context_length")), positive_tokens(model.get("max_completion_tokens")))
}

/// Token fields used by Anthropic, OpenAI-compatible, Gemini and extension
/// catalogs. Use declared maxima, not defaultLength or a guessed model family.
pub(super) fn declared(model: &Value) -> (Option<u32>, Option<u32>) {
    let read = |keys: &[&str]| keys.iter().find_map(|key| positive_tokens(model.pointer(key)));
    (
        read(&["/max_input_tokens", "/maxInputTokens", "/inputTokenLimit", "/context_length", "/context_window", "/capabilities/maxInputTokens"]),
        read(&["/max_output_tokens", "/maxOutputTokens", "/max_tokens", "/max_completion_tokens", "/outputTokenLimit", "/capabilities/maxOutputTokens"]),
    )
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
    fn catalog_fields_keep_maxima_and_ignore_client_defaults() {
        assert_eq!(declared(&json!({"max_input_tokens":1000000,"max_tokens":128000})), (Some(1000000), Some(128000)));
        assert_eq!(declared(&json!({"inputTokenLimit":"1048576","outputTokenLimit":65536})), (Some(1048576), Some(65536)));
        assert_eq!(declared(&json!({"contextWindow":{"defaultLength":8000}})), (None, None));
        assert_eq!(declared(&json!({"maxInputTokens":0,"maxOutputTokens":-1})), (None, None));
    }
}
