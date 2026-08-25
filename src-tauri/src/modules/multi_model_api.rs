use crate::models::claude::ClaudeAuthMode;
use crate::models::codex::CodexAuthMode;
use crate::modules::atomic_write::{parse_json_with_auto_restore, write_string_atomic};
use crate::modules::{
    account, claude_account, codex_account, codex_local_access, gemini_account, logger, process,
};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex, OnceLock,
};
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

const STATE_FILE: &str = "multi_model_api_service.json";
const SIDECAR_DIR: &str = "multi_model_api_service";
const DEFAULT_PORT: u16 = 1466;
const CLAUDE_WEB_HELPER_PORT_OFFSET: u16 = 1;
const WATCHDOG_INTERVAL_SECONDS: u64 = 15;
const WATCHDOG_RESTART_COOLDOWN_SECONDS: u64 = 30;
const WATCHDOG_MAX_RESTART_COOLDOWN_SECONDS: u64 = 300;
const WATCHDOG_FAILURE_THRESHOLD: u32 = 3;
static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelApiKey {
    pub id: String,
    pub label: String,
    pub key: String,
    #[serde(default)]
    pub allowed_models: Vec<String>,
    #[serde(default)]
    pub excluded_models: Vec<String>,
    #[serde(default)]
    pub account_ids: Vec<String>,
    #[serde(default)]
    pub model_prefix: String,
    #[serde(default)]
    pub provider_gateway: Option<Value>,
    #[serde(default)]
    pub source: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelDefinition {
    pub id: String,
    #[serde(default)]
    pub alias: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelAccount {
    pub id: String,
    pub name: String,
    pub provider: String,
    #[serde(default = "default_auth_mode")]
    pub auth_mode: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub credential_json: Option<Value>,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub models: Vec<MultiModelDefinition>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelApiConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_scope")]
    pub access_scope: String,
    #[serde(default)]
    pub upstream_proxy: String,
    #[serde(default = "default_routing")]
    pub routing_strategy: String,
    #[serde(default = "default_true")]
    pub session_affinity: bool,
    #[serde(default = "default_session_ttl")]
    pub session_affinity_ttl: String,
    #[serde(default = "default_retries")]
    pub request_retries: u8,
    #[serde(default)]
    pub debug_logs: bool,
    #[serde(default)]
    pub api_keys: Vec<MultiModelApiKey>,
    #[serde(default)]
    pub accounts: Vec<MultiModelAccount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelApiState {
    pub config: MultiModelApiConfig,
    pub running: bool,
    pub base_url: String,
    pub last_error: Option<String>,
    pub catalog: Vec<MultiModelCatalogEntry>,
    pub self_heal: MultiModelSelfHealState,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelSelfHealState {
    pub status: String,
    pub consecutive_failures: u32,
    pub restart_attempts: u32,
    pub restart_failures: u32,
    pub last_success_at: Option<String>,
    pub last_repair_at: Option<String>,
    pub next_restart_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelCatalogEntry {
    pub provider: String,
    pub id: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelApiTestResult {
    pub ok: bool,
    pub status: u16,
    pub latency_ms: u64,
    pub model: String,
    pub response: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelRepairCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelRepairReport {
    pub ok: bool,
    pub repaired: usize,
    pub restarted: bool,
    pub checked_at: String,
    pub duration_ms: u64,
    pub checks: Vec<MultiModelRepairCheck>,
    pub state: MultiModelApiState,
}

#[derive(Default)]
struct RuntimeState {
    child: Option<Child>,
    helpers: Vec<Child>,
    last_error: Option<String>,
}

#[derive(Default)]
struct SelfHealRuntime {
    consecutive_failures: u32,
    restart_attempts: u32,
    restart_failures: u32,
    last_success_at: Option<String>,
    last_repair_at: Option<String>,
    next_restart_at: Option<String>,
    next_restart_after: Option<Instant>,
    last_error: Option<String>,
}

struct ClaudeWebLaunch {
    config_path: PathBuf,
    runtime_path: PathBuf,
    port: u16,
}

struct MultiModelLaunch {
    config_path: PathBuf,
    runtime_path: PathBuf,
    claude_web: Option<ClaudeWebLaunch>,
}

fn runtime() -> &'static Mutex<RuntimeState> {
    static RUNTIME: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(RuntimeState::default()))
}

fn lifecycle() -> &'static Mutex<()> {
    static LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();
    LIFECYCLE.get_or_init(|| Mutex::new(()))
}

fn repair_lifecycle() -> &'static Mutex<()> {
    static REPAIR_LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();
    REPAIR_LIFECYCLE.get_or_init(|| Mutex::new(()))
}

fn self_heal_runtime() -> &'static Mutex<SelfHealRuntime> {
    static SELF_HEAL_RUNTIME: OnceLock<Mutex<SelfHealRuntime>> = OnceLock::new();
    SELF_HEAL_RUNTIME.get_or_init(|| Mutex::new(SelfHealRuntime::default()))
}

fn default_true() -> bool {
    true
}
fn default_port() -> u16 {
    DEFAULT_PORT
}
fn default_scope() -> String {
    "localhost".into()
}
fn default_auth_mode() -> String {
    "api_key".into()
}
fn default_routing() -> String {
    "round-robin".into()
}
fn default_session_ttl() -> String {
    "1h".into()
}
fn default_retries() -> u8 {
    2
}

fn random_key() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
    format!("cle-mm-{suffix}")
}

fn default_config() -> MultiModelApiConfig {
    MultiModelApiConfig {
        enabled: false,
        port: DEFAULT_PORT,
        access_scope: default_scope(),
        upstream_proxy: String::new(),
        routing_strategy: default_routing(),
        session_affinity: true,
        session_affinity_ttl: default_session_ttl(),
        request_retries: default_retries(),
        debug_logs: false,
        api_keys: vec![MultiModelApiKey {
            id: uuid::Uuid::new_v4().to_string(),
            label: "默认全模型 Key".into(),
            key: random_key(),
            allowed_models: Vec::new(),
            excluded_models: Vec::new(),
            account_ids: Vec::new(),
            model_prefix: String::new(),
            provider_gateway: None,
            source: "cle:generated".into(),
            enabled: true,
        }],
        accounts: Vec::new(),
    }
}

fn data_dir() -> Result<PathBuf, String> {
    account::get_data_dir()
        .or_else(|_| account::resolve_data_dir())
        .map_err(|error| format!("解析多模型 API 数据目录失败: {error}"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(STATE_FILE))
}

fn sidecar_dir() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(SIDECAR_DIR))
}

fn load_config() -> Result<MultiModelApiConfig, String> {
    let path = state_path()?;
    if !path.exists() {
        let mut config = default_config();
        let migration = migrate_legacy_key_records(&mut config)?;
        normalize_config(&mut config)?;
        save_config_file(&config)?;
        if let Some((marker, marker_payload)) = migration {
            write_string_atomic(&marker, &marker_payload)?;
        }
        return Ok(config);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("读取多模型 API 配置失败: {error}"))?;
    let mut config: MultiModelApiConfig = parse_json_with_auto_restore(&path, &raw)
        .map_err(|error| format!("解析多模型 API 配置失败: {error}"))?;
    normalize_config(&mut config)?;
    if let Some((marker, marker_payload)) = migrate_legacy_key_records(&mut config)? {
        // Normalize again because imported records came from older schemas.
        normalize_config(&mut config)?;
        save_config_file(&config)?;
        write_string_atomic(&marker, &marker_payload)?;
    }
    Ok(config)
}

fn migrate_legacy_key_records(
    config: &mut MultiModelApiConfig,
) -> Result<Option<(PathBuf, String)>, String> {
    let current_root = data_dir()?;
    let marker = current_root.join(".legacy_multi_model_keys_migrated_v1");
    if marker.exists() {
        return Ok(None);
    }

    let mut sources: Vec<(PathBuf, &'static str, &'static str)> = Vec::new();
    if let Some(parent) = current_root.parent() {
        let cockpit = parent.join(".antigravity_cockpit");
        sources.push((
            cockpit
                .join("codex_local_access_sidecar")
                .join("manifest.json"),
            "apiKeys",
            "legacy:cockpit:codex-sidecar",
        ));
        sources.push((
            cockpit.join(STATE_FILE),
            "apiKeys",
            "legacy:cockpit:multi-model",
        ));
    }
    #[cfg(windows)]
    sources.push((
        PathBuf::from(r"F:\C.le.控制台\desktop-src\multi-platform-proxy-api\config.json"),
        "localApiKeys",
        "legacy:old-console:multi-platform-proxy-api",
    ));

    let archive_root = current_root
        .join("legacy_import")
        .join("api_service_records");
    std::fs::create_dir_all(&archive_root)
        .map_err(|error| format!("创建旧 API 服务记录归档失败: {error}"))?;
    let mut imported = 0usize;
    let mut archived = 0usize;
    let mut discovered = 0usize;
    for (index, (path, property, source)) in sources.iter().enumerate() {
        if !path.is_file() {
            continue;
        }
        let raw = std::fs::read_to_string(path)
            .map_err(|error| format!("读取旧 API Key 记录失败 {}: {error}", path.display()))?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|error| format!("解析旧 API Key 记录失败 {}: {error}", path.display()))?;
        let archive_name = format!(
            "{index:02}-{}",
            path.file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("records.json")
        );
        let archive_path = archive_root.join(archive_name);
        if !archive_path.exists() {
            std::fs::copy(path, &archive_path)
                .map_err(|error| format!("归档旧 API Key 记录失败 {}: {error}", path.display()))?;
        }
        archived += 1;
        if let Some(records) = value.get(*property).and_then(Value::as_array) {
            discovered += records.len();
            imported += merge_legacy_api_keys(config, records, source);
        }
    }

    let marker_payload = serde_json::to_string_pretty(&json!({
        "version": 1,
        "migratedAt": chrono::Utc::now().to_rfc3339(),
        "archivedSourceFiles": archived,
        "discoveredRecords": discovered,
        "importedUniqueRecords": imported,
        "finalKeyRecords": config.api_keys.len(),
        "archiveDir": archive_root.to_string_lossy()
    }))
    .unwrap_or_else(|_| "{\"version\":1}".into());
    Ok(Some((marker, marker_payload)))
}

fn merge_legacy_api_keys(
    config: &mut MultiModelApiConfig,
    records: &[Value],
    source: &str,
) -> usize {
    let mut imported = 0usize;
    for (index, record) in records.iter().enumerate() {
        let key = record
            .as_str()
            .or_else(|| record.get("key").and_then(Value::as_str))
            .or_else(|| record.get("apiKey").and_then(Value::as_str))
            .unwrap_or_default()
            .trim()
            .to_string();
        if key.is_empty() || config.api_keys.iter().any(|item| item.key == key) {
            continue;
        }
        let string_list = |name: &str| {
            record
                .get(name)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(ToOwned::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        let legacy_label = record
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Key");
        config.api_keys.push(MultiModelApiKey {
            id: record
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("legacy-{value}"))
                .unwrap_or_else(|| format!("legacy-key-{}-{index}", uuid::Uuid::new_v4())),
            label: format!("旧记录 · {legacy_label}"),
            key,
            allowed_models: string_list("allowedModels"),
            excluded_models: string_list("excludedModels"),
            account_ids: string_list("accountIds"),
            model_prefix: record
                .get("modelPrefix")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            provider_gateway: record
                .get("providerGateway")
                .cloned()
                .filter(|value| !value.is_null()),
            source: source.to_string(),
            enabled: record
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        });
        imported += 1;
    }
    imported
}

fn save_config_file(config: &MultiModelApiConfig) -> Result<(), String> {
    let path = state_path()?;
    let raw = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化多模型 API 配置失败: {error}"))?;
    write_string_atomic(&path, &raw)
}

fn normalize_config(config: &mut MultiModelApiConfig) -> Result<(), String> {
    if config.port == 0 {
        config.port = DEFAULT_PORT;
    }
    config.access_scope = match config.access_scope.trim().to_ascii_lowercase().as_str() {
        "lan" => "lan".into(),
        _ => "localhost".into(),
    };
    config.routing_strategy = match config.routing_strategy.trim().to_ascii_lowercase().as_str() {
        "fill-first" | "fill_first" => "fill-first".into(),
        _ => "round-robin".into(),
    };
    if config.session_affinity_ttl.trim().is_empty() {
        config.session_affinity_ttl = default_session_ttl();
    }
    // Zero disables failover in the upstream SDK, while excessive retries can
    // duplicate paid generation work and amplify provider outages.
    config.request_retries = config.request_retries.clamp(1, 4);
    let mut keys = BTreeSet::new();
    for item in &mut config.api_keys {
        item.id = item.id.trim().to_string();
        if item.id.is_empty() {
            item.id = uuid::Uuid::new_v4().to_string();
        }
        item.key = item.key.trim().to_string();
        if item.key.is_empty() {
            item.key = random_key();
        }
        if !keys.insert(item.key.clone()) {
            return Err("下游 API Key 不能重复".into());
        }
    }
    let mut account_ids = BTreeSet::new();
    for account in &mut config.accounts {
        account.id = account.id.trim().to_string();
        if account.id.is_empty() {
            account.id = uuid::Uuid::new_v4().to_string();
        }
        if !account_ids.insert(account.id.clone()) {
            return Err(format!("账号 ID 重复: {}", account.id));
        }
        account.provider = normalize_provider(&account.provider);
        if account.name.trim().is_empty() {
            account.name = format!("{} account", account.provider);
        }
        if account.enabled
            && account.auth_mode != "oauth_json"
            && account.api_key.trim().is_empty()
            && account.credential_json.is_none()
        {
            return Err(format!(
                "账号 {} 缺少 API Key 或 OAuth credential",
                account.name
            ));
        }
        for model in &mut account.models {
            model.id = model.id.trim().to_string();
            model.alias = model.alias.trim().to_string();
        }
        account.models.retain(|model| !model.id.is_empty());
    }
    Ok(())
}

fn normalize_provider(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "anthropic" | "claude" => "claude".into(),
        "google" | "gemini" => "gemini".into(),
        "grok" | "x.ai" | "xai" => "xai".into(),
        "seedance" | "doubao-seedance" | "doubao_seedance" => "doubao-seedance".into(),
        "openai" => "openai".into(),
        "codex" => "codex".into(),
        "" => "openai".into(),
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

fn builtin_catalog() -> Vec<MultiModelCatalogEntry> {
    let specs: &[(&str, &str, &[&str])] = &[
        ("xai", "grok-4.3", &["text", "vision", "reasoning"]),
        ("xai", "grok-4.20-0309-reasoning", &["text", "reasoning"]),
        ("xai", "grok-4.20-0309-non-reasoning", &["text"]),
        ("xai", "grok-4.20-multi-agent-0309", &["text", "reasoning"]),
        ("xai", "grok-3-mini", &["text", "reasoning"]),
        ("xai", "grok-3-mini-fast", &["text", "reasoning"]),
        ("xai", "grok-imagine-image", &["image"]),
        ("xai", "grok-imagine-image-quality", &["image"]),
        ("xai", "grok-imagine-video", &["video"]),
        (
            "antigravity",
            "claude-opus-4-6-thinking",
            &["text", "vision", "reasoning"],
        ),
        (
            "antigravity",
            "claude-sonnet-4-6",
            &["text", "vision", "reasoning"],
        ),
        (
            "antigravity",
            "gemini-3-pro-high",
            &["text", "vision", "reasoning"],
        ),
        ("antigravity", "gemini-3-flash", &["text", "vision"]),
        (
            "antigravity",
            "gemini-3.1-flash-image",
            &["text", "vision", "image"],
        ),
        ("antigravity", "veo-3.1-generate-preview", &["video"]),
        ("openai", "gpt-5.4", &["text", "vision", "reasoning"]),
        ("openai", "gpt-5.4-mini", &["text", "vision", "reasoning"]),
        ("openai", "gpt-image-2", &["image"]),
        (
            "claude",
            "claude-opus-4-6",
            &["text", "vision", "reasoning"],
        ),
        (
            "claude",
            "claude-sonnet-4-6",
            &["text", "vision", "reasoning"],
        ),
        (
            "gemini",
            "gemini-3.1-pro-preview",
            &["text", "vision", "reasoning"],
        ),
        ("gemini", "gemini-3-flash-preview", &["text", "vision"]),
        ("gemini", "veo-3.1-generate-preview", &["video"]),
        ("gemini", "veo-3.0-generate-preview", &["video"]),
        ("doubao-seedance", "doubao-seedance-1.5-pro", &["video"]),
        (
            "doubao-seedance",
            "doubao-seedance-1.0-pro-fast",
            &["video"],
        ),
    ];
    specs
        .iter()
        .map(|(provider, id, caps)| MultiModelCatalogEntry {
            provider: (*provider).into(),
            id: (*id).into(),
            capabilities: caps.iter().map(|item| (*item).into()).collect(),
        })
        .collect()
}

fn catalog_for_config(config: &MultiModelApiConfig) -> Vec<MultiModelCatalogEntry> {
    let mut result = builtin_catalog();
    let mut seen: BTreeSet<(String, String)> = result
        .iter()
        .map(|entry| (entry.provider.clone(), entry.id.to_ascii_lowercase()))
        .collect();
    for account in &config.accounts {
        for model in &account.models {
            let key = (account.provider.clone(), model.id.to_ascii_lowercase());
            if model.enabled && seen.insert(key) {
                result.push(MultiModelCatalogEntry {
                    provider: account.provider.clone(),
                    id: model.id.clone(),
                    capabilities: model.capabilities.clone(),
                });
            }
        }
    }
    result
}

fn model_json(model: &MultiModelDefinition, image_flag: bool) -> Value {
    let mut value = json!({"name": model.id, "alias": model.alias});
    if image_flag && model.capabilities.iter().any(|cap| cap == "image") {
        value["image"] = Value::Bool(true);
    }
    value
}

fn claude_web_cookie_value<'a>(auth_export: &'a Value, name: &str) -> Option<&'a str> {
    auth_export
        .get("cookies")?
        .as_array()?
        .iter()
        .find(|cookie| cookie.get("name").and_then(Value::as_str) == Some(name))?
        .get("value")?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn claude_web_runtime_account(
    account: &MultiModelAccount,
    fallback_proxy_url: &str,
) -> Result<Value, String> {
    let credential = account
        .credential_json
        .as_ref()
        .ok_or_else(|| format!("Claude Web 账号 {} 缺少认证记录", account.name))?;
    let export_path = credential
        .get("auth_export_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Claude Web 账号 {} 缺少 auth export 路径", account.name))?;
    let raw = std::fs::read_to_string(export_path).map_err(|error| {
        format!(
            "读取 Claude Web 账号 {} 的 auth export 失败: {error}",
            account.name
        )
    })?;
    let auth_export: Value = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "解析 Claude Web 账号 {} 的 auth export 失败: {error}",
            account.name
        )
    })?;
    let session_key = claude_web_cookie_value(&auth_export, "sessionKey")
        .ok_or_else(|| format!("Claude Web 账号 {} 缺少 sessionKey", account.name))?;
    let organization_id = claude_web_cookie_value(&auth_export, "lastActiveOrg")
        .ok_or_else(|| format!("Claude Web 账号 {} 缺少 lastActiveOrg", account.name))?;
    let cookie_header = auth_export
        .get("cookies")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|cookie| {
            let name = cookie.get("name")?.as_str()?.trim();
            let value = cookie.get("value")?.as_str()?.trim();
            if name.is_empty()
                || value.is_empty()
                || name.contains([';', '='])
                || value.contains(['\r', '\n', ';'])
            {
                return None;
            }
            Some(format!("{name}={value}"))
        })
        .collect::<Vec<_>>()
        .join("; ");
    let proxy_url = if account.proxy_url.trim().is_empty() {
        fallback_proxy_url.trim()
    } else {
        account.proxy_url.trim()
    };
    Ok(json!({
        "id": account.id,
        "label": account.name,
        "sessionKey": session_key,
        "lastActiveOrg": organization_id,
        "cookieHeader": cookie_header,
        "proxyUrl": proxy_url,
        "enabled": true
    }))
}

fn loopback_proxy_is_available(proxy_url: &str) -> Option<bool> {
    let parsed = url::Url::parse(proxy_url.trim()).ok()?;
    let host = parsed.host_str()?.trim_matches(|ch| ch == '[' || ch == ']');
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return None;
    }
    let port = parsed.port_or_known_default()?;
    let address = format!("127.0.0.1:{port}").parse().ok()?;
    Some(
        std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(350))
            .is_ok(),
    )
}

fn write_launch_files(config: &MultiModelApiConfig) -> Result<MultiModelLaunch, String> {
    let root = sidecar_dir()?;
    let auths = root.join("auths");
    std::fs::create_dir_all(&auths)
        .map_err(|error| format!("创建多模型 API sidecar 目录失败: {error}"))?;

    let mut gemini_keys = Vec::new();
    let mut codex_keys = Vec::new();
    let mut claude_keys = Vec::new();
    let mut compat = Vec::new();
    let mut providers = BTreeSet::new();
    let mut model_ids = BTreeSet::new();
    let mut aliases = Vec::new();
    let mut manifest_accounts = Vec::new();
    let mut account_auth_ids = BTreeMap::new();
    let mut expected_auth_files = BTreeSet::new();
    let effective_upstream_proxy = if config.upstream_proxy.trim().is_empty() {
        let detected = codex_local_access::system_proxy_url_for_target("https://api.openai.com")
            .unwrap_or_default();
        if loopback_proxy_is_available(&detected) == Some(false) {
            logger::log_warn(&format!(
                "[MultiModelAPI] 检测到本机系统代理但端口不可用，已自动回退直连: {}",
                detected
            ));
            String::new()
        } else {
            detected
        }
    } else {
        config.upstream_proxy.trim().to_string()
    };
    let helper_port = config
        .port
        .checked_add(CLAUDE_WEB_HELPER_PORT_OFFSET)
        .unwrap_or(config.port - 1);
    let claude_web_internal_key = random_key();
    let mut claude_web_accounts = Vec::new();
    let mut claude_web_models = BTreeMap::<String, MultiModelDefinition>::new();

    for account in config.accounts.iter().filter(|item| item.enabled) {
        let models: Vec<_> = account.models.iter().filter(|item| item.enabled).collect();
        for model in &models {
            model_ids.insert(model.id.clone());
            if !model.alias.is_empty() {
                model_ids.insert(model.alias.clone());
                aliases.push(json!({"sourceModel": model.id, "alias": model.alias, "fork": true}));
            }
        }
        let provider = normalize_provider(&account.provider);
        let key = account.api_key.trim();
        let common = json!({
            "api-key": key,
            "priority": account.priority,
            "prefix": account.prefix,
            "base-url": account.base_url,
            "proxy-url": account.proxy_url,
            "headers": account.headers,
            "models": models.iter().map(|item| model_json(item, false)).collect::<Vec<_>>()
        });
        match provider.as_str() {
            "claude-web" => {
                providers.insert("claude-web".to_string());
                claude_web_accounts.push(claude_web_runtime_account(
                    account,
                    &effective_upstream_proxy,
                )?);
                for model in &models {
                    claude_web_models
                        .entry(model.id.to_ascii_lowercase())
                        .or_insert_with(|| (*model).clone());
                }
            }
            "xai" if account.auth_mode == "oauth_json" || account.credential_json.is_some() => {
                // Native xAI OAuth credentials must be file-backed so CLIProxyAPI can
                // select the xAI executor and refresh expired access tokens.  Treating
                // them as OpenAI-compatible API keys leaves an empty api-key entry and
                // makes every Grok request fail with `auth_not_found`.
                let credential = account.credential_json.clone().unwrap_or_else(|| json!({}));
                let credential = normalize_oauth_credential("xai", credential);
                providers.insert("xai".to_string());
                write_auth_file(&auths, &account.id, &credential, &mut expected_auth_files)?;
            }
            "xai" => {
                providers.insert("xai".to_string());
                // xAI API keys use the OpenAI-compatible credential synthesizer.
                // OAuth credentials are handled by the guarded arm above.
                compat.push(json!({
                    "name": "xai",
                    "priority": account.priority,
                    "prefix": account.prefix,
                    "base-url": if account.base_url.trim().is_empty() { "https://api.x.ai/v1" } else { &account.base_url },
                    "api-key-entries": [{"api-key": key, "proxy-url": account.proxy_url}],
                    "models": models.iter().map(|item| model_json(item, true)).collect::<Vec<_>>(),
                    "headers": account.headers
                }));
            }
            "codex" if account.auth_mode != "oauth_json" => {
                providers.insert("codex".to_string());
                codex_keys.push(common);
            }
            "claude" if account.auth_mode != "oauth_json" => {
                providers.insert("claude".to_string());
                claude_keys.push(common);
            }
            "gemini" if account.auth_mode != "oauth_json" => {
                providers.insert("gemini".to_string());
                gemini_keys.push(common);
            }
            "openai" if account.auth_mode != "oauth_json" => {
                providers.insert("openai".to_string());
                compat.push(json!({
                    "name": "openai",
                    "priority": account.priority,
                    "prefix": account.prefix,
                    "base-url": if account.base_url.trim().is_empty() { "https://api.openai.com/v1" } else { &account.base_url },
                    "api-key-entries": [{"api-key": key, "proxy-url": account.proxy_url}],
                    "models": models.iter().map(|item| model_json(item, true)).collect::<Vec<_>>(),
                    "headers": account.headers
                }));
            }
            "doubao-seedance" => {
                // Seedance uses browser connect.sid credentials and is handled
                // directly by the integrated Go gateway on the same 1466 port.
                // Do not synthesize a second OpenAI-compatible upstream here.
                providers.insert("doubao-seedance".to_string());
            }
            _ if account.auth_mode == "oauth_json" || account.credential_json.is_some() => {
                let credential = account.credential_json.clone().unwrap_or_else(|| json!({}));
                let mut credential = normalize_oauth_credential(&provider, credential);
                if credential.get("type").is_none() {
                    credential["type"] = Value::String(provider.clone());
                }
                let credential_type = credential
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(&provider);
                providers.insert(normalize_provider(credential_type));
                write_auth_file(&auths, &account.id, &credential, &mut expected_auth_files)?;
            }
            _ => {
                providers.insert(provider.clone());
                compat.push(json!({
                    "name": provider,
                    "priority": account.priority,
                    "prefix": account.prefix,
                    "base-url": account.base_url,
                    "api-key-entries": [{"api-key": key, "proxy-url": account.proxy_url}],
                    "models": models.iter().map(|item| model_json(item, true)).collect::<Vec<_>>(),
                    "headers": account.headers
                }));
            }
        }
        let manifest_provider = if provider == "claude-web" {
            "claude-web".to_string()
        } else if account.auth_mode == "oauth_json" {
            account
                .credential_json
                .as_ref()
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str)
                .map(normalize_provider)
                .unwrap_or_else(|| provider.clone())
        } else {
            provider.clone()
        };
        let manifest_auth_id = if provider == "claude-web" {
            account.id.clone()
        } else if account.auth_mode == "oauth_json" || account.credential_json.is_some() {
            format!("{}.json", safe_file_name(&account.id))
        } else {
            account.id.clone()
        };
        account_auth_ids.insert(account.id.clone(), manifest_auth_id.clone());
        manifest_accounts.push(json!({
            "id": account.id,
            "email": account.name,
            "authId": manifest_auth_id,
            "upstreamApiKey": if provider == "claude-web" { claude_web_internal_key.as_str() } else { key },
            "provider": manifest_provider,
            "baseUrl": account.base_url,
            "proxyUrl": if account.proxy_url.trim().is_empty() { effective_upstream_proxy.as_str() } else { account.proxy_url.as_str() },
            "headers": account.headers,
            "priority": account.priority,
            "models": models.iter().flat_map(|model| {
                let mut ids = vec![model.id.clone()];
                if !model.alias.trim().is_empty() {
                    ids.push(model.alias.clone());
                }
                ids
            }).collect::<Vec<_>>()
        }));
    }

    let claude_web_launch = if claude_web_accounts.is_empty() {
        None
    } else {
        let helper_dir = root.join("claude-web");
        std::fs::create_dir_all(&helper_dir)
            .map_err(|error| format!("创建 Claude Web helper 目录失败: {error}"))?;
        let helper_config_path = helper_dir.join("config.json");
        let helper_runtime_path = helper_dir.join("runtime.json");
        let helper_config = json!({
            "enabled": true,
            "listenHost": "127.0.0.1",
            "listenPort": helper_port,
            "upstreamBaseUrl": "https://claude.ai",
            "transportMode": "direct_http",
            "helperMode": "disabled",
            "probeBeforeStart": false,
            "preferBrowserOn403": false,
            "respectRetryAfter": true,
            "streamFirstChunkTimeoutMs": 12000,
            "maxRetries": config.request_retries.max(1),
            "cooldownMinutes": 15,
            "claudeDailyLimit": 100,
            "requireApiKey": false,
            "localApiKey": claude_web_internal_key,
            "accounts": claude_web_accounts
        });
        write_string_atomic(
            &helper_config_path,
            &serde_json::to_string_pretty(&helper_config).unwrap(),
        )?;
        let helper_model_values = claude_web_models
            .values()
            .map(|model| model_json(model, false))
            .collect::<Vec<_>>();
        compat.push(json!({
            "name": "claude-web",
            "priority": 0,
            "base-url": format!("http://127.0.0.1:{helper_port}/v1"),
            // The global proxy is intended for remote providers.  Explicitly
            // bypass it for the loopback helper or the proxy turns a healthy
            // local Claude response into an immediate 502.
            "api-key-entries": [{"api-key": claude_web_internal_key, "proxy-url": "direct"}],
            "models": helper_model_values
        }));
        Some(ClaudeWebLaunch {
            config_path: helper_config_path,
            runtime_path: helper_runtime_path,
            port: helper_port,
        })
    };

    for entry in builtin_catalog() {
        if providers.contains(&entry.provider)
            || (entry.provider == "gemini" && providers.contains("gemini-cli"))
        {
            model_ids.insert(entry.id);
        }
    }
    cleanup_auth_files(&auths, &expected_auth_files)?;

    let bind = if config.access_scope == "lan" {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let config_path = root.join("config.json");
    let runtime_path = root.join("runtime_state.json");
    let sidecar_config = json!({
        "host": bind,
        "port": config.port,
        "auth-dir": auths.to_string_lossy(),
        "api-keys": config.api_keys.iter().filter(|item| item.enabled).map(|item| item.key.clone()).collect::<Vec<_>>(),
        "proxy-url": effective_upstream_proxy,
        "request-retry": config.request_retries,
        "nonstream-keepalive-interval": 15,
        "streaming": {
            "keepalive-seconds": 15,
            "bootstrap-retries": config.request_retries.min(2),
            "bootstrap-retry-base-delay-ms": 350,
            "bootstrap-retry-max-delay-ms": 2500,
            "stream-open-timeout-ms": 30000,
            "stream-idle-timeout-ms": 90000,
            "image-stream-open-timeout-ms": 120000,
            "image-stream-idle-timeout-ms": 180000,
            "stream-open-max-attempts": config.request_retries.min(2).saturating_add(1)
        },
        "debug": config.debug_logs,
        "request-log": config.debug_logs,
        "passthrough-headers": true,
        "disable-image-generation": false,
        "routing": {
            "strategy": config.routing_strategy,
            "session-affinity": config.session_affinity,
            "session-affinity-ttl": config.session_affinity_ttl
        },
        "gemini-api-key": gemini_keys,
        "codex-api-key": codex_keys,
        "claude-api-key": claude_keys,
        "openai-compatibility": compat
    });
    let runtime_state = json!({
        "apiKeys": config.api_keys.iter().map(|item| json!({
            "id": item.id,
            "label": item.label,
            "key": item.key,
            "allowedModels": item.allowed_models,
            "excludedModels": item.excluded_models,
            "accountIds": item.account_ids.iter().filter_map(|account_id| {
                account_auth_ids.get(account_id).cloned().or_else(|| {
                    account_auth_ids.values().any(|auth_id| auth_id == account_id).then(|| account_id.clone())
                })
            }).collect::<Vec<_>>(),
            "modelPrefix": item.model_prefix,
            "providerGateway": item.provider_gateway,
            "enabled": item.enabled
        })).collect::<Vec<_>>(),
        "accounts": manifest_accounts,
        "modelIds": model_ids,
        "modelAliases": aliases,
        "excludedModels": [],
        "routingStrategy": config.routing_strategy,
        "providers": providers,
        "nativeModelRegistry": true,
        "debugLogs": config.debug_logs
    });
    write_string_atomic(
        &config_path,
        &serde_json::to_string_pretty(&sidecar_config).unwrap(),
    )?;
    write_string_atomic(
        &runtime_path,
        &serde_json::to_string_pretty(&runtime_state).unwrap(),
    )?;
    Ok(MultiModelLaunch {
        config_path,
        runtime_path,
        claude_web: claude_web_launch,
    })
}

fn safe_file_name(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn write_auth_file(
    dir: &Path,
    id: &str,
    credential: &Value,
    expected: &mut BTreeSet<String>,
) -> Result<(), String> {
    let file = format!("{}.json", safe_file_name(id));
    expected.insert(file.clone());
    let raw = serde_json::to_string_pretty(credential)
        .map_err(|error| format!("序列化账号 credential 失败: {error}"))?;
    write_string_atomic(&dir.join(file), &raw)
}

fn cleanup_auth_files(dir: &Path, expected: &BTreeSet<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|error| format!("读取 auth 目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取 auth 文件失败: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_file() && name.ends_with(".json") && !expected.contains(&name) {
            std::fs::remove_file(entry.path())
                .map_err(|error| format!("清理旧 auth 文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn claude_web_binary_file_names() -> Vec<String> {
    let target = env!("CLE_RUST_TARGET");
    if cfg!(target_os = "windows") {
        vec![
            format!("cockpit-cliproxy-{target}.exe"),
            "cockpit-cliproxy.exe".into(),
        ]
    } else {
        vec![
            format!("cockpit-cliproxy-{target}"),
            "cockpit-cliproxy".into(),
        ]
    }
}

fn push_claude_web_binary_candidates(candidates: &mut Vec<PathBuf>, dir: &Path) {
    for name in claude_web_binary_file_names() {
        let path = dir.join(name);
        if !candidates.iter().any(|candidate| candidate == &path) {
            candidates.push(path);
        }
    }
}

fn claude_web_binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("读取当前程序路径失败: {error}"))?;
    let parent = exe.parent().ok_or("当前程序路径没有父目录")?;
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_dir = manifest_dir.join("../sidecars/cockpit-cliproxy/bin");
    let mut candidates = Vec::new();
    if cfg!(debug_assertions) {
        push_claude_web_binary_candidates(&mut candidates, &dev_dir);
    }
    push_claude_web_binary_candidates(&mut candidates, parent);
    if let Some(contents_dir) = parent.parent() {
        push_claude_web_binary_candidates(&mut candidates, &contents_dir.join("Resources"));
    }
    if !cfg!(debug_assertions) {
        push_claude_web_binary_candidates(&mut candidates, &dev_dir);
    }
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .ok_or_else(|| {
            format!(
                "Claude Web helper 二进制不存在，已检查: {}。请重新构建应用。",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
}

async fn start_claude_web_helper(launch: &ClaudeWebLaunch) -> Result<Child, String> {
    let binary = claude_web_binary_path()?;
    let mut command = Command::new(&binary);
    command
        .arg("--config")
        .arg(&launch.config_path)
        .arg("--runtime-state")
        .arg(&launch.runtime_path)
        .current_dir(
            launch
                .config_path
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Claude Web helper: {error}"))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logger::log_warn(&format!("[MultiModelAPI][claude-web] {line}"));
            }
        });
    }
    let address = format!("127.0.0.1:{}", launch.port);
    for _ in 0..100 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Claude Web helper 提前退出: {status}"));
        }
        if tokio::net::TcpStream::connect(&address).await.is_ok() {
            return Ok(child);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = child.kill().await;
    Err("Claude Web helper 启动超时".into())
}

async fn stop_runtime_locked(state: &mut RuntimeState) {
    if let Some(mut child) = state.child.take() {
        let _ = child.kill().await;
        let _ = timeout(Duration::from_secs(5), child.wait()).await;
    }
    for mut helper in state.helpers.drain(..) {
        let _ = helper.kill().await;
        let _ = timeout(Duration::from_secs(5), helper.wait()).await;
    }
}

fn oauth_expiration(credential: &Value) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    for key in ["expired", "expiry", "expires_at", "expiresAt"] {
        if let Some(value) = credential.get(key).and_then(Value::as_str) {
            if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value.trim()) {
                return Some(parsed);
            }
        }
    }
    None
}

fn hydrate_persisted_xai_credentials(config: &mut MultiModelApiConfig) -> Result<bool, String> {
    let auth_dir = sidecar_dir()?.join("auths");
    let mut changed = false;
    for account in config.accounts.iter_mut().filter(|account| {
        account.enabled
            && normalize_provider(&account.provider) == "xai"
            && (account.auth_mode == "oauth_json" || account.credential_json.is_some())
    }) {
        let path = auth_dir.join(format!("{}.json", safe_file_name(&account.id)));
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(persisted) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        if persisted.get("type").and_then(Value::as_str) != Some("xai")
            || persisted
                .get("access_token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .is_empty()
        {
            continue;
        }
        let incoming_expiry = account.credential_json.as_ref().and_then(oauth_expiration);
        let persisted_expiry = oauth_expiration(&persisted);
        let persisted_is_newer = match (persisted_expiry, incoming_expiry) {
            (Some(persisted), Some(incoming)) => persisted > incoming,
            (Some(_), None) => true,
            _ => {
                persisted.get("last_refresh").is_some()
                    && account
                        .credential_json
                        .as_ref()
                        .and_then(|value| value.get("last_refresh"))
                        .is_none()
            }
        };
        if persisted_is_newer {
            account.credential_json = Some(persisted);
            changed = true;
        }
    }
    Ok(changed)
}

async fn refresh_xai_credentials(config: &mut MultiModelApiConfig, force: bool) -> bool {
    const XAI_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
    let system_proxy = codex_local_access::system_proxy_url_for_target("https://auth.x.ai");
    let mut changed = false;

    for account in config.accounts.iter_mut().filter(|account| {
        account.enabled
            && normalize_provider(&account.provider) == "xai"
            && (account.auth_mode == "oauth_json" || account.credential_json.is_some())
    }) {
        let Some(credential) = account.credential_json.as_mut() else {
            continue;
        };
        let due = force
            || oauth_expiration(credential)
                .map(|expiry| {
                    expiry <= chrono::Utc::now().fixed_offset() + chrono::Duration::minutes(5)
                })
                .unwrap_or_else(|| {
                    credential
                        .get("access_token")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .is_empty()
                });
        if !due {
            continue;
        }
        let refresh_token = credential
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if refresh_token.is_empty() {
            logger::log_warn(&format!(
                "[MultiModelAPI][xAI] 账号 {} 已过期但缺少 refresh_token",
                account.name
            ));
            continue;
        }
        let token_endpoint = credential
            .get("token_endpoint")
            .or_else(|| credential.get("token_url"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("https://auth.x.ai/oauth2/token")
            .to_string();

        let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(20));
        let proxy_url = account
            .proxy_url
            .trim()
            .is_empty()
            .then(|| system_proxy.as_deref())
            .flatten()
            .unwrap_or_else(|| account.proxy_url.trim());
        if !proxy_url.is_empty() {
            match reqwest::Proxy::all(proxy_url) {
                Ok(proxy) => builder = builder.proxy(proxy),
                Err(error) => {
                    logger::log_warn(&format!(
                        "[MultiModelAPI][xAI] 账号 {} 的代理地址无效: {error}",
                        account.name
                    ));
                    continue;
                }
            }
        }
        let Ok(client) = builder.build() else {
            continue;
        };
        let response = client
            .post(&token_endpoint)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", XAI_CLIENT_ID),
                ("refresh_token", refresh_token.as_str()),
            ])
            .send()
            .await;
        let Ok(response) = response else {
            logger::log_warn(&format!(
                "[MultiModelAPI][xAI] 账号 {} token 刷新请求失败",
                account.name
            ));
            continue;
        };
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            logger::log_warn(&format!(
                "[MultiModelAPI][xAI] 账号 {} token 刷新失败: status={}, body_len={}",
                account.name,
                status,
                body.len()
            ));
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(&body) else {
            logger::log_warn(&format!(
                "[MultiModelAPI][xAI] 账号 {} token 刷新响应不是有效 JSON",
                account.name
            ));
            continue;
        };
        let access_token = payload
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if access_token.is_empty() {
            continue;
        }
        credential["access_token"] = Value::String(access_token.to_string());
        if let Some(value) = payload
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            credential["refresh_token"] = Value::String(value.to_string());
        }
        for key in ["id_token", "token_type", "scope"] {
            if let Some(value) = payload.get(key).cloned() {
                credential[key] = value;
            }
        }
        let expires_in = payload
            .get("expires_in")
            .and_then(Value::as_i64)
            .unwrap_or(21_600)
            .max(60);
        credential["expires_in"] = Value::Number(expires_in.into());
        credential["expired"] = Value::String(
            (chrono::Utc::now() + chrono::Duration::seconds(expires_in)).to_rfc3339(),
        );
        credential["last_refresh"] = Value::String(chrono::Utc::now().to_rfc3339());
        credential["token_endpoint"] = Value::String(token_endpoint);
        credential["auth_kind"] = Value::String("oauth".to_string());
        changed = true;
        logger::log_info(&format!(
            "[MultiModelAPI][xAI] 账号 {} token 已刷新",
            account.name
        ));
    }
    changed
}

async fn port_is_listening(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_ok()
}

async fn wait_for_port_release(port: u16) -> Result<(), String> {
    for _ in 0..50 {
        if !port_is_listening(port).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("端口 {port} 未在期限内释放"))
}

/// A TCP listener alone is not enough evidence that the port belongs to our
/// gateway: a stale helper or an unrelated local program can be bound to the
/// configured port.  Keep this probe deliberately unauthenticated so it can
/// be used during startup, before the model catalogue and downstream key are
/// available.
async fn probe_sidecar_health(port: u16) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(800))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("创建 sidecar 健康检查客户端失败: {error}"))?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/healthz"))
        .send()
        .await
        .map_err(|error| format!("sidecar 健康端点连接失败: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 sidecar 健康端点失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("sidecar 健康端点返回 HTTP {}", status.as_u16()));
    }
    let health: Value =
        serde_json::from_str(&body).map_err(|_| "sidecar 健康端点未返回 JSON".to_string())?;
    if health.get("status").and_then(Value::as_str) != Some("ok")
        || health.get("service").and_then(Value::as_str) != Some("cle-cliproxy")
    {
        return Err("监听端口不是 C.le. 多模型 API sidecar".to_string());
    }
    Ok(())
}

async fn start_runtime(config: &MultiModelApiConfig, adopt_existing: bool) -> Result<(), String> {
    // Saving, account synchronization, and startup restoration can all request a
    // restart at nearly the same time.  Serialize the complete stop/start flow so
    // two helpers or sidecars never race for the same ports.
    let _lifecycle_guard = lifecycle().lock().await;
    let mut effective_config = config.clone();
    let mut credential_changed = hydrate_managed_antigravity_credentials(&mut effective_config)
        .unwrap_or_else(|error| {
            logger::log_warn(&format!(
                "[MultiModelAPI] 同步 Antigravity 实时凭据失败，继续使用最近快照: {error}"
            ));
            false
        });
    credential_changed |= hydrate_persisted_xai_credentials(&mut effective_config)?;
    credential_changed |= refresh_xai_credentials(&mut effective_config, false).await;
    if credential_changed {
        save_config_file(&effective_config)?;
    }
    {
        let mut state = runtime().lock().await;
        stop_runtime_locked(&mut state).await;
    }
    let launch = write_launch_files(&effective_config)?;
    let helper_port = launch.claude_web.as_ref().map(|helper| helper.port);
    if adopt_existing
        && probe_sidecar_health(effective_config.port).await.is_ok()
        && match helper_port {
            Some(port) => port_is_listening(port).await,
            None => true,
        }
    {
        let mut state = runtime().lock().await;
        state.last_error = None;
        logger::log_info("[MultiModelAPI] 已采用独立后台 API sidecar");
        return Ok(());
    }
    for port in std::iter::once(effective_config.port).chain(helper_port) {
        if port_is_listening(port).await {
            process::kill_port_processes(port)
                .map_err(|error| format!("停止占用端口 {port} 的旧 API sidecar 失败: {error}"))?;
            wait_for_port_release(port).await?;
        }
    }
    let binary = codex_local_access::sidecar_binary_path()?;
    let mut helper_children = Vec::new();
    if let Some(claude_web) = launch.claude_web.as_ref() {
        helper_children.push(start_claude_web_helper(claude_web).await?);
    }
    let config_path = launch.config_path;
    let runtime_path = launch.runtime_path;
    let mut command = Command::new(&binary);
    command
        .arg("--config")
        .arg(&config_path)
        .arg("--manifest")
        .arg(&runtime_path)
        .current_dir(config_path.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            for mut helper in helper_children {
                let _ = helper.kill().await;
            }
            return Err(format!("Failed to start multi-model API sidecar: {error}"));
        }
    };
    let stdout = child.stdout.take().ok_or("sidecar stdout 不可用")?;
    let stderr = child.stderr.take();
    let (ready_tx, ready_rx) = oneshot::channel();
    let startup_stdout = Arc::new(StdMutex::new(Vec::<String>::new()));
    let startup_stderr = Arc::new(StdMutex::new(Vec::<String>::new()));
    let stdout_diagnostics = Arc::clone(&startup_stdout);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut ready_tx = Some(ready_tx);
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                if let Ok(mut recent) = stdout_diagnostics.lock() {
                    recent.push(trimmed.to_string());
                    if recent.len() > 12 {
                        recent.remove(0);
                    }
                }
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                if value.get("type").and_then(Value::as_str) == Some("ready") {
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(());
                    }
                } else if value.get("type").and_then(Value::as_str) == Some("error") {
                    logger::log_warn(&format!("[MultiModelAPI][sidecar] {trimmed}"));
                }
            }
        }
    });
    if let Some(stderr) = stderr {
        let stderr_diagnostics = Arc::clone(&startup_stderr);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(mut recent) = stderr_diagnostics.lock() {
                    recent.push(line.trim().to_string());
                    if recent.len() > 12 {
                        recent.remove(0);
                    }
                }
                logger::log_warn(&format!("[MultiModelAPI][sidecar] {line}"));
            }
        });
    }

    // A successful /healthz response from *our* sidecar is authoritative
    // runtime evidence.  A listening socket or a delayed stdout event alone
    // must not be accepted: that previously allowed a stale foreign process
    // on the configured port to masquerade as a ready API service.
    let address = format!("127.0.0.1:{}", effective_config.port);
    let mut ready_rx = ready_rx;
    let mut ready_channel_open = true;
    let started_at = Instant::now();
    let ready = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("检查多模型 API sidecar 状态失败: {error}"))?
        {
            break Err(format!("多模型 API sidecar 在就绪前退出: {status}"));
        }

        if tokio::net::TcpStream::connect(&address).await.is_ok()
            && probe_sidecar_health(effective_config.port).await.is_ok()
        {
            break Ok(());
        }
        if started_at.elapsed() >= Duration::from_secs(20) {
            break Err("多模型 API sidecar 启动超时".to_string());
        }

        if ready_channel_open {
            tokio::select! {
                result = &mut ready_rx => {
                    match result {
                        // The ready event only shortens the next health probe;
                        // it never bypasses the ownership check above.
                        Ok(()) => {},
                        Err(_) => ready_channel_open = false,
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        } else {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };

    if ready.is_ok() {
        // Guard against accepting a socket from a process that exits immediately
        // after binding (for example, malformed runtime state).
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("检查多模型 API sidecar 状态失败: {error}"))?
        {
            let stdout = startup_stdout
                .lock()
                .ok()
                .map(|v| v.join(" | "))
                .unwrap_or_default();
            let stderr = startup_stderr
                .lock()
                .ok()
                .map(|v| v.join(" | "))
                .unwrap_or_default();
            for mut helper in helper_children {
                let _ = helper.kill().await;
            }
            return Err(format!(
                "多模型 API sidecar 启动后立即退出: {status}; stdout={stdout}; stderr={stderr}"
            ));
        }
        let mut state = runtime().lock().await;
        state.child = Some(child);
        state.helpers = helper_children;
        state.last_error = None;
        return Ok(());
    }

    let _ = child.kill().await;
    for mut helper in helper_children {
        let _ = helper.kill().await;
    }
    let stdout = startup_stdout
        .lock()
        .ok()
        .map(|v| v.join(" | "))
        .unwrap_or_default();
    let stderr = startup_stderr
        .lock()
        .ok()
        .map(|v| v.join(" | "))
        .unwrap_or_default();
    Err(format!(
        "{}，未监听 {address}; stdout={stdout}; stderr={stderr}",
        ready
            .err()
            .unwrap_or_else(|| "多模型 API sidecar 启动失败".to_string())
    ))
}

fn normalize_oauth_credential(provider: &str, mut credential: Value) -> Value {
    let Some(object) = credential.as_object_mut() else {
        return credential;
    };

    let credential_type = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(provider)
        .trim()
        .to_ascii_lowercase();

    if provider == "xai" || credential_type == "xai" {
        object.insert("type".to_string(), Value::String("xai".to_string()));
        object
            .entry("auth_kind".to_string())
            .or_insert_with(|| Value::String("oauth".to_string()));
        if !object.contains_key("token_endpoint") {
            if let Some(token_url) = object.get("token_url").cloned() {
                object.insert("token_endpoint".to_string(), token_url);
            }
        }
        return credential;
    }

    if provider == "gemini" || matches!(credential_type.as_str(), "gemini" | "gemini-cli") {
        object.insert("type".to_string(), Value::String("gemini-cli".to_string()));

        let expiry = object
            .get("expiry")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                object
                    .get("expired")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                let raw = object.get("expiry_date")?;
                let timestamp = raw
                    .as_i64()
                    .or_else(|| raw.as_u64().and_then(|value| i64::try_from(value).ok()))
                    .or_else(|| raw.as_str().and_then(|value| value.parse::<i64>().ok()))?;
                let millis = if timestamp.abs() < 10_000_000_000 {
                    timestamp.saturating_mul(1000)
                } else {
                    timestamp
                };
                chrono::DateTime::from_timestamp_millis(millis).map(|value| value.to_rfc3339())
            });
        if let Some(expiry) = expiry.clone() {
            object.insert("expiry".to_string(), Value::String(expiry));
        }

        if !object.contains_key("token") {
            let mut token = serde_json::Map::new();
            for key in ["access_token", "refresh_token", "token_type"] {
                if let Some(value) = object.get(key).cloned() {
                    token.insert(key.to_string(), value);
                }
            }
            if let Some(expiry) = expiry {
                token.insert("expiry".to_string(), Value::String(expiry));
            }
            if !token.is_empty() {
                object.insert("token".to_string(), Value::Object(token));
            }
        }
    }

    credential
}

/// Refresh the gateway snapshot from the authoritative account-manager store.
/// Antigravity access tokens are short lived and may be rotated by quota refresh
/// after the multi-model service was configured. Without this hydration the
/// account page can be healthy while API model calls still use an old token.
fn hydrate_managed_antigravity_credentials(
    config: &mut MultiModelApiConfig,
) -> Result<bool, String> {
    let managed = account::list_accounts()?;
    let by_id = managed
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<BTreeMap<_, _>>();
    let mut changed = false;
    for upstream in config.accounts.iter_mut().filter(|item| {
        item.provider == "antigravity" && item.source.starts_with("cle:antigravity:")
    }) {
        let managed_id = upstream
            .source
            .strip_prefix("cle:antigravity:")
            .unwrap_or_default();
        let Some(current) = by_id.get(managed_id) else {
            continue;
        };
        let fresh = json!({
            "type": "antigravity",
            "access_token": current.token.access_token,
            "refresh_token": current.token.refresh_token,
            "expires_in": current.token.expires_in,
            "expired": chrono::DateTime::from_timestamp(current.token.expiry_timestamp, 0)
                .map(|item| item.to_rfc3339()),
            "email": current.email,
            "project_id": current.token.project_id
        });
        if upstream.credential_json.as_ref() != Some(&fresh) {
            upstream.credential_json = Some(fresh);
            changed = true;
        }
    }
    Ok(changed)
}

fn write_managed_antigravity_auth_files(config: &MultiModelApiConfig) -> Result<(), String> {
    let auth_dir = sidecar_dir()?.join("auths");
    std::fs::create_dir_all(&auth_dir)
        .map_err(|error| format!("创建多模型 API auth 目录失败: {error}"))?;
    for account in config.accounts.iter().filter(|item| {
        item.enabled
            && item.provider == "antigravity"
            && item.source.starts_with("cle:antigravity:")
    }) {
        let Some(credential) = account.credential_json.as_ref() else {
            continue;
        };
        let path = auth_dir.join(format!("{}.json", safe_file_name(&account.id)));
        let raw = serde_json::to_string_pretty(credential)
            .map_err(|error| format!("序列化 Antigravity API 凭据失败: {error}"))?;
        write_string_atomic(&path, &raw)?;
    }
    Ok(())
}

async fn apply_config(config: &MultiModelApiConfig) -> Result<(), String> {
    if config.enabled {
        start_runtime(config, false).await
    } else {
        let _lifecycle_guard = lifecycle().lock().await;
        let mut state = runtime().lock().await;
        stop_runtime_locked(&mut state).await;
        state.last_error = None;
        drop(state);
        for port in [
            config.port,
            config.port.saturating_add(CLAUDE_WEB_HELPER_PORT_OFFSET),
        ] {
            if port_is_listening(port).await {
                process::kill_port_processes(port)
                    .map_err(|error| format!("停止占用端口 {port} 的 API sidecar 失败: {error}"))?;
                wait_for_port_release(port).await?;
            }
        }
        Ok(())
    }
}

fn watchdog_restart_delay(restart_failures: u32) -> Duration {
    let exponent = restart_failures.min(4);
    let seconds = WATCHDOG_RESTART_COOLDOWN_SECONDS
        .saturating_mul(1_u64 << exponent)
        .min(WATCHDOG_MAX_RESTART_COOLDOWN_SECONDS);
    Duration::from_secs(seconds)
}

async fn self_heal_snapshot() -> MultiModelSelfHealState {
    let state = self_heal_runtime().lock().await;
    let status = if state.consecutive_failures == 0 {
        if state.last_success_at.is_some() {
            "healthy"
        } else {
            "idle"
        }
    } else if state.next_restart_after.is_some() {
        "recovering"
    } else {
        "degraded"
    };
    MultiModelSelfHealState {
        status: status.to_string(),
        consecutive_failures: state.consecutive_failures,
        restart_attempts: state.restart_attempts,
        restart_failures: state.restart_failures,
        last_success_at: state.last_success_at.clone(),
        last_repair_at: state.last_repair_at.clone(),
        next_restart_at: state.next_restart_at.clone(),
        last_error: state.last_error.clone(),
    }
}

async fn record_health_success(repaired: bool) {
    let mut state = self_heal_runtime().lock().await;
    state.consecutive_failures = 0;
    state.restart_failures = 0;
    state.next_restart_after = None;
    state.next_restart_at = None;
    state.last_error = None;
    state.last_success_at = Some(chrono::Utc::now().to_rfc3339());
    if repaired {
        state.last_repair_at = state.last_success_at.clone();
    }
}

async fn record_health_failure(error: impl Into<String>) -> u32 {
    let mut state = self_heal_runtime().lock().await;
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    state.last_error = Some(error.into());
    state.consecutive_failures
}

pub async fn get_state() -> Result<MultiModelApiState, String> {
    let config = load_config()?;
    let (owned_running, last_error) = {
        let mut state = runtime().lock().await;
        let had_child = state.child.is_some();
        let running = if let Some(child) = state.child.as_mut() {
            child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
        } else {
            false
        };
        if had_child && !running {
            stop_runtime_locked(&mut state).await;
        }
        (running, state.last_error.clone())
    };
    let running = owned_running || port_is_listening(config.port).await;
    let host = if config.access_scope == "lan" {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    Ok(MultiModelApiState {
        base_url: format!("http://{host}:{}", config.port),
        catalog: catalog_for_config(&config),
        config,
        running,
        last_error,
        self_heal: self_heal_snapshot().await,
    })
}

fn repair_check(
    id: &str,
    label: &str,
    status: &str,
    detail: impl Into<String>,
    action: Option<&str>,
) -> MultiModelRepairCheck {
    MultiModelRepairCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: status.to_string(),
        detail: detail.into(),
        action: action.map(ToOwned::to_owned),
    }
}

async fn probe_gateway(config: &MultiModelApiConfig) -> Result<String, String> {
    let base_url = format!("http://127.0.0.1:{}", config.port);
    let key = config
        .api_keys
        .iter()
        .find(|item| item.enabled && !item.key.trim().is_empty())
        .map(|item| item.key.trim())
        .ok_or("没有启用的下游 API Key")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("创建本地健康检查客户端失败: {error}"))?;

    let health = client
        .get(format!("{base_url}/healthz"))
        .send()
        .await
        .map_err(|error| format!("健康端点连接失败: {error}"))?;
    let health_status = health.status();
    let health_body = health
        .text()
        .await
        .map_err(|error| format!("读取健康端点失败: {error}"))?;
    if !health_status.is_success() {
        return Err(format!("健康端点返回 HTTP {}", health_status.as_u16()));
    }
    let health: Value =
        serde_json::from_str(&health_body).map_err(|_| "健康端点未返回有效 JSON".to_string())?;
    if health.get("status").and_then(Value::as_str) != Some("ok")
        || health.get("service").and_then(Value::as_str) != Some("cle-cliproxy")
    {
        return Err("健康端点不属于 C.le. 多模型 API sidecar".to_string());
    }

    let models = client
        .get(format!("{base_url}/v1/models"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| format!("模型目录连接失败: {error}"))?;
    let status = models.status();
    let body = models
        .text()
        .await
        .map_err(|error| format!("读取模型目录失败: {error}"))?;
    if !status.is_success() {
        return Err(format!("模型目录返回 HTTP {}", status.as_u16()));
    }
    let count = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| value.get("data").and_then(Value::as_array).map(Vec::len))
        .ok_or("模型目录不是有效的 OpenAI-compatible 响应")?;
    if count == 0 {
        return Err("模型目录为空".into());
    }
    Ok(format!("健康端点正常，模型目录包含 {count} 个模型"))
}

async fn probe_route_contract(config: &MultiModelApiConfig, path: &str) -> Result<u16, String> {
    let key = config
        .api_keys
        .iter()
        .find(|item| item.enabled && !item.key.trim().is_empty())
        .map(|item| item.key.trim())
        .ok_or("没有启用的下游 API Key")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(format!("http://127.0.0.1:{}{path}", config.port))
        .bearer_auth(key)
        .json(&json!({}))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if matches!(status, 404 | 405) {
        return Err(format!("端点 {path} 未注册（HTTP {status}）"));
    }
    if matches!(status, 401 | 403) {
        return Err(format!("端点 {path} 拒绝本地 API Key（HTTP {status}）"));
    }
    if status >= 500 {
        let summary = body
            .chars()
            .filter(|character| !character.is_control())
            .take(180)
            .collect::<String>();
        return Err(format!(
            "端点 {path} 返回上游/服务错误（HTTP {status}）{}",
            if summary.is_empty() {
                String::new()
            } else {
                format!("：{summary}")
            }
        ));
    }
    Ok(status)
}

async fn local_bridge_models(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<MultiModelDefinition>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.get(format!("{}/models", base_url.trim_end_matches('/')));
    if !api_key.trim().is_empty() {
        request = request.bearer_auth(api_key.trim());
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("模型目录返回 HTTP {}", response.status().as_u16()));
    }
    let value: Value = response.json().await.map_err(|error| error.to_string())?;
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(|id| model_definition(id.to_string()))
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Err("模型目录为空".to_string());
    }
    Ok(models)
}

fn local_aurora_api_key() -> String {
    if let Ok(value) = std::env::var("CLE_AURORA_API_KEY") {
        let value = value.trim();
        if !value.is_empty() {
            return value.to_string();
        }
    }
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("CLE_AURORA_PATH") {
        if let Some(parent) = Path::new(&path).parent() {
            candidates.push(parent.join("new_api_key.txt"));
        }
    }
    #[cfg(windows)]
    candidates.push(PathBuf::from(r"F:\自动注册\AuroraProxy\new_api_key.txt"));
    candidates
        .into_iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "local-aurora".to_string())
}

fn upsert_local_bridge_account(
    config: &mut MultiModelApiConfig,
    id: &str,
    name: &str,
    provider: &str,
    base_url: &str,
    api_key: &str,
    models: Vec<MultiModelDefinition>,
) {
    let account = MultiModelAccount {
        id: id.to_string(),
        name: name.to_string(),
        provider: provider.to_string(),
        auth_mode: "api_key".to_string(),
        base_url: base_url.to_string(),
        api_key: api_key.to_string(),
        credential_json: None,
        proxy_url: "direct".to_string(),
        prefix: String::new(),
        priority: 10,
        headers: BTreeMap::new(),
        models,
        enabled: true,
        source: "cle:local-gpt-bridge".to_string(),
    };
    if let Some(existing) = config.accounts.iter_mut().find(|item| item.id == id) {
        *existing = account;
    } else {
        config.accounts.push(account);
    }
}

/// Discover the locally managed Chat2API/Aurora services and expose them
/// through the same stable OpenAI-compatible gateway and downstream keys.
pub async fn sync_local_gpt_bridges() -> Result<MultiModelApiState, String> {
    let _repair_guard = repair_lifecycle().lock().await;
    let mut config = load_config()?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;

    let chat_tokens = client
        .get("http://127.0.0.1:5005/tokens")
        .send()
        .await
        .map_err(|error| format!("Chat2API 未就绪，请先启动：{error}"))?;
    if !chat_tokens.status().is_success() {
        return Err(format!(
            "Chat2API 账号管理端点返回 HTTP {}",
            chat_tokens.status().as_u16()
        ));
    }
    upsert_local_bridge_account(
        &mut config,
        "local-chat2api",
        "Chat2API 免费账号池",
        "chat2api",
        "http://127.0.0.1:5005/v1",
        "cle-chat2api-pool",
        ["gpt-4o", "gpt-4o-mini", "o3-mini", "o1-mini"]
            .into_iter()
            .map(|id| model_definition(id.to_string()))
            .collect(),
    );

    let aurora_key = local_aurora_api_key();
    let aurora_models = local_bridge_models("http://127.0.0.1:8080/v1", &aurora_key)
        .await
        .map_err(|error| format!("Aurora 未就绪或认证失败：{error}"))?;
    upsert_local_bridge_account(
        &mut config,
        "local-aurora",
        "Aurora GPT 免费账号池",
        "aurora",
        "http://127.0.0.1:8080/v1",
        &aurora_key,
        aurora_models,
    );

    normalize_config(&mut config)?;
    save_config_file(&config)?;
    write_launch_files(&config)?;
    if config.enabled {
        start_runtime(&config, false).await?;
        record_health_success(true).await;
    }
    get_state().await
}

pub async fn diagnose_and_repair(deep: bool) -> Result<MultiModelRepairReport, String> {
    // Multiple UI clicks, startup recovery and the background watchdog must not
    // run overlapping repair passes against the same ports and auth files.
    let _repair_guard = repair_lifecycle().lock().await;
    let started = Instant::now();
    let mut checks = Vec::new();
    let mut repaired = 0usize;
    let mut restarted = false;
    let mut credential_runtime_changed = false;
    let mut config = load_config()?;

    let root = sidecar_dir()?;
    std::fs::create_dir_all(&root).map_err(|error| format!("创建 API 服务目录失败: {error}"))?;
    let write_probe = root.join(".self-repair-write-test");
    match std::fs::write(&write_probe, b"ok").and_then(|_| std::fs::remove_file(&write_probe)) {
        Ok(()) => checks.push(repair_check(
            "storage",
            "配置与运行目录",
            "ok",
            format!("目录可读写：{}", root.display()),
            None,
        )),
        Err(error) => checks.push(repair_check(
            "storage",
            "配置与运行目录",
            "error",
            format!("目录不可写：{error}"),
            None,
        )),
    }

    if config
        .api_keys
        .iter()
        .all(|item| !item.enabled || item.key.trim().is_empty())
    {
        config.api_keys.push(MultiModelApiKey {
            id: uuid::Uuid::new_v4().to_string(),
            label: "自动修复 Key".into(),
            key: random_key(),
            allowed_models: Vec::new(),
            excluded_models: Vec::new(),
            account_ids: Vec::new(),
            model_prefix: String::new(),
            provider_gateway: None,
            source: "cle:self-repair".into(),
            enabled: true,
        });
        save_config_file(&config)?;
        repaired += 1;
        checks.push(repair_check(
            "api-key",
            "下游 API Key",
            "repaired",
            "未发现可用 Key，已生成新的本地下游 Key",
            Some("生成 Key"),
        ));
    } else {
        checks.push(repair_check(
            "api-key",
            "下游 API Key",
            "ok",
            "至少有一个启用的下游 Key",
            None,
        ));
    }

    match hydrate_managed_antigravity_credentials(&mut config) {
        Ok(true) => {
            save_config_file(&config)?;
            write_managed_antigravity_auth_files(&config)?;
            repaired += 1;
            checks.push(repair_check(
                "antigravity-credential",
                "Antigravity 实时凭据",
                "repaired",
                "已从账号管理同步最新 access token 到多模型 API 运行账号",
                Some("同步实时凭据"),
            ));
        }
        Ok(false) => checks.push(repair_check(
            "antigravity-credential",
            "Antigravity 实时凭据",
            "ok",
            "多模型 API 凭据已与账号管理保持一致",
            None,
        )),
        Err(error) => checks.push(repair_check(
            "antigravity-credential",
            "Antigravity 实时凭据",
            "warning",
            format!("读取账号管理凭据失败，暂用最近快照：{error}"),
            None,
        )),
    }

    match hydrate_persisted_xai_credentials(&mut config) {
        Ok(hydrated) => {
            let refreshed = refresh_xai_credentials(&mut config, true).await;
            if hydrated || refreshed {
                save_config_file(&config)?;
                repaired += 1;
                credential_runtime_changed = true;
                checks.push(repair_check(
                    "xai-credential",
                    "xAI OAuth 凭据",
                    "repaired",
                    "已从持久化登录恢复或刷新到期的 xAI OAuth 凭据",
                    Some("刷新 OAuth"),
                ));
            } else {
                checks.push(repair_check(
                    "xai-credential",
                    "xAI OAuth 凭据",
                    "ok",
                    "已检查 xAI OAuth 持久化记录与有效期",
                    None,
                ));
            }
        }
        Err(error) => checks.push(repair_check(
            "xai-credential",
            "xAI OAuth 凭据",
            "error",
            error,
            Some("重新授权 xAI 账号"),
        )),
    }

    match codex_local_access::sidecar_binary_path() {
        Ok(path) if path.is_file() => checks.push(repair_check(
            "binary",
            "API sidecar 可执行文件",
            "ok",
            format!("已找到 {}", path.display()),
            None,
        )),
        Ok(path) => checks.push(repair_check(
            "binary",
            "API sidecar 可执行文件",
            "error",
            format!("文件不存在：{}", path.display()),
            None,
        )),
        Err(error) => checks.push(repair_check(
            "binary",
            "API sidecar 可执行文件",
            "error",
            error,
            None,
        )),
    }

    let enabled_accounts = config.accounts.iter().filter(|item| item.enabled).count();
    let enabled_models = config
        .accounts
        .iter()
        .filter(|item| item.enabled)
        .flat_map(|item| item.models.iter())
        .filter(|item| item.enabled)
        .count();
    let account_status = if enabled_accounts == 0 || enabled_models == 0 {
        "warning"
    } else {
        "ok"
    };
    checks.push(repair_check(
        "accounts",
        "账号池与模型声明",
        account_status,
        format!("{enabled_accounts} 个启用账号，{enabled_models} 条启用模型声明"),
        None,
    ));

    let runtime_files_were_missing = !root.join("config.json").is_file()
        || !root.join("runtime_state.json").is_file()
        || !root.join("auths").is_dir();
    match write_launch_files(&config) {
        Ok(_) => {
            if runtime_files_were_missing {
                repaired += 1;
            }
            checks.push(repair_check(
                "runtime-files",
                "运行配置与认证索引",
                if runtime_files_were_missing {
                    "repaired"
                } else {
                    "ok"
                },
                "已重新生成并校验 sidecar 配置、模型清单和认证文件",
                runtime_files_were_missing.then_some("重建运行文件"),
            ));
        }
        Err(error) => checks.push(repair_check(
            "runtime-files",
            "运行配置与认证索引",
            "error",
            error,
            None,
        )),
    }

    if !config.upstream_proxy.trim().is_empty()
        && loopback_proxy_is_available(&config.upstream_proxy) == Some(false)
    {
        checks.push(repair_check(
            "upstream-proxy",
            "上游代理",
            "warning",
            "配置的本机代理端口当前不可连接；保留显式配置，请启动代理或改为留空自动检测",
            None,
        ));
    } else {
        checks.push(repair_check(
            "upstream-proxy",
            "上游代理",
            "ok",
            if config.upstream_proxy.trim().is_empty() {
                "使用自动检测；无可用本机代理时自动回退直连"
            } else {
                "显式代理端口可连接"
            },
            None,
        ));
    }

    if config.enabled {
        let initial_probe = probe_gateway(&config).await;
        if credential_runtime_changed || initial_probe.is_err() {
            match start_runtime(&config, false).await {
                Ok(()) => {
                    restarted = true;
                    repaired += 1;
                    checks.push(repair_check(
                        "runtime",
                        "服务进程与端口",
                        "repaired",
                        if credential_runtime_changed {
                            "OAuth 凭据已更新，已重新启动独立 sidecar 使其立即生效"
                        } else {
                            "检测到服务未就绪，已清理冲突进程并重新启动独立 sidecar"
                        },
                        Some("重启 sidecar"),
                    ));
                }
                Err(error) => checks.push(repair_check(
                    "runtime",
                    "服务进程与端口",
                    "error",
                    format!("自动重启失败：{error}"),
                    None,
                )),
            }
        } else {
            checks.push(repair_check(
                "runtime",
                "服务进程与端口",
                "ok",
                "独立 sidecar 正在监听配置端口",
                None,
            ));
        }

        match probe_gateway(&config).await {
            Ok(detail) => {
                record_health_success(restarted).await;
                checks.push(repair_check(
                    "gateway",
                    "健康端点与模型目录",
                    "ok",
                    detail,
                    None,
                ));
            }
            Err(error) => {
                record_health_failure(error.clone()).await;
                checks.push(repair_check(
                    "gateway",
                    "健康端点与模型目录",
                    "error",
                    error,
                    None,
                ));
            }
        }

        for (id, label, path) in [
            ("chat-route", "文本生成端点", "/v1/chat/completions"),
            ("image-route", "图片生成端点", "/v1/images/generations"),
            ("video-route", "视频生成端点", "/v1/videos/generations"),
        ] {
            match probe_route_contract(&config, path).await {
                Ok(status) => checks.push(repair_check(
                    id,
                    label,
                    "ok",
                    format!("路由已注册，空载校验返回 HTTP {status}"),
                    None,
                )),
                Err(error) => checks.push(repair_check(id, label, "error", error, None)),
            }
        }

        if deep {
            let provider_models = provider_chat_test_models(&config);
            if provider_models.is_empty() {
                checks.push(repair_check(
                    "upstream-call",
                    "真实上游调用",
                    "error",
                    "账号池中没有可测试的文本模型",
                    None,
                ));
            } else {
                // Probe providers serially.  A repair action must not turn into
                // a burst against every upstream account and trigger a shared
                // rate-limit/cooldown window.
                for (index, (provider, model)) in provider_models.into_iter().enumerate() {
                    if index > 0 {
                        tokio::time::sleep(Duration::from_millis(350)).await;
                    }
                    let result = test_chat(
                        Some(model.clone()),
                        Some("Reply with exactly: gateway-ok".into()),
                    )
                    .await;
                    let check_id = format!(
                        "upstream-{}",
                        provider
                            .chars()
                            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
                            .collect::<String>()
                    );
                    match result {
                        Ok(result) if result.ok => checks.push(repair_check(
                            &check_id,
                            &format!("{} 真实上游", provider),
                            "ok",
                            format!(
                                "模型 {} 调用成功，延迟 {}ms",
                                result.model, result.latency_ms
                            ),
                            None,
                        )),
                        Ok(result) => checks.push(repair_check(
                            &check_id,
                            &format!("{} 真实上游", provider),
                            "error",
                            format!(
                                "模型 {} 返回 HTTP {}：{}",
                                result.model, result.status, result.response
                            ),
                            Some("检查账号授权、额度或上游代理"),
                        )),
                        Err(error) => checks.push(repair_check(
                            &check_id,
                            &format!("{} 真实上游", provider),
                            "error",
                            format!("模型 {model} 调用失败：{error}"),
                            Some("重新授权该供应商账号"),
                        )),
                    }
                }
            }
        }
    } else {
        checks.push(repair_check(
            "runtime",
            "服务进程与端口",
            "warning",
            "服务配置为停用；已完成静态检查但未自动启动",
            None,
        ));
    }

    let self_heal = self_heal_snapshot().await;
    checks.push(repair_check(
        "self-heal-policy",
        "后台自愈与熔断策略",
        if self_heal.status == "degraded" {
            "warning"
        } else {
            "ok"
        },
        format!(
            "状态 {}，连续故障 {} 次，累计恢复 {} 次，恢复失败 {} 次；连续 {} 次探测失败后才重启，失败退避最长 {} 秒",
            self_heal.status,
            self_heal.consecutive_failures,
            self_heal.restart_attempts,
            self_heal.restart_failures,
            WATCHDOG_FAILURE_THRESHOLD,
            WATCHDOG_MAX_RESTART_COOLDOWN_SECONDS,
        ),
        None,
    ));

    let state = get_state().await?;
    let ok = !checks.iter().any(|item| item.status == "error");
    Ok(MultiModelRepairReport {
        ok,
        repaired,
        restarted,
        checked_at: chrono::Utc::now().to_rfc3339(),
        duration_ms: started.elapsed().as_millis() as u64,
        checks,
        state,
    })
}

pub async fn save_config(mut config: MultiModelApiConfig) -> Result<MultiModelApiState, String> {
    normalize_config(&mut config)?;
    save_config_file(&config)?;
    if let Err(error) = apply_config(&config).await {
        let mut state = runtime().lock().await;
        state.last_error = Some(error.clone());
        return Err(error);
    }
    get_state().await
}

pub async fn set_enabled(enabled: bool) -> Result<MultiModelApiState, String> {
    let mut config = load_config()?;
    config.enabled = enabled;
    save_config(config).await
}

fn test_provider_priority(provider: &str) -> u8 {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" => 0,
        "claude-web" => 1,
        "openai" | "claude" | "custom" => 2,
        "antigravity" => 3,
        "gemini" => 4,
        "xai" => 5,
        _ => 6,
    }
}

fn test_model_priority(model: &str) -> u8 {
    let normalized = model.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "gpt-5.4-mini" | "claude-haiku-4-5" => 0,
        _ if normalized.contains("mini")
            || normalized.contains("flash")
            || normalized.contains("haiku") =>
        {
            1
        }
        _ => 2,
    }
}

fn is_chat_test_model(model: &str) -> bool {
    let normalized = model
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    !matches!(
        normalized.as_str(),
        "codex-auto-review"
            | "gpt-image-2"
            | "grok-imagine-image"
            | "grok-imagine-image-quality"
            | "grok-imagine-video"
    )
}

fn provider_chat_test_models(config: &MultiModelApiConfig) -> Vec<(String, String)> {
    let mut providers_by_model = BTreeMap::<String, BTreeSet<String>>::new();
    for account in config.accounts.iter().filter(|account| account.enabled) {
        let provider = account.provider.trim().to_ascii_lowercase();
        for model in account.models.iter().filter(|model| model.enabled) {
            let supports_text = model.capabilities.is_empty()
                || model
                    .capabilities
                    .iter()
                    .any(|capability| capability.eq_ignore_ascii_case("text"));
            let client_model = if model.alias.trim().is_empty() {
                model.id.trim()
            } else {
                model.alias.trim()
            };
            if supports_text && is_chat_test_model(client_model) && !client_model.is_empty() {
                providers_by_model
                    .entry(client_model.to_ascii_lowercase())
                    .or_default()
                    .insert(provider.clone());
            }
        }
    }

    let mut candidates = BTreeMap::<String, Vec<(u8, u8, String, String)>>::new();
    for account in config.accounts.iter().filter(|account| account.enabled) {
        let provider = account.provider.trim().to_ascii_lowercase();
        for model in account.models.iter().filter(|model| model.enabled) {
            let supports_text = model.capabilities.is_empty()
                || model
                    .capabilities
                    .iter()
                    .any(|capability| capability.eq_ignore_ascii_case("text"));
            let client_model = if model.alias.trim().is_empty() {
                model.id.trim()
            } else {
                model.alias.trim()
            };
            if !supports_text || !is_chat_test_model(client_model) || client_model.is_empty() {
                continue;
            }
            let normalized = client_model.to_ascii_lowercase();
            let shared = providers_by_model
                .get(&normalized)
                .map(|providers| providers.len() > 1)
                .unwrap_or(false);
            candidates.entry(provider.clone()).or_default().push((
                u8::from(shared),
                test_model_priority(client_model),
                normalized,
                client_model.to_string(),
            ));
        }
    }

    candidates
        .into_iter()
        .filter_map(|(provider, mut models)| {
            models.sort();
            models
                .into_iter()
                .next()
                .map(|(_, _, _, model)| (provider, model))
        })
        .collect()
}

fn automatic_chat_test_models(config: &MultiModelApiConfig) -> Vec<String> {
    let mut candidates = config
        .accounts
        .iter()
        .filter(|account| account.enabled)
        .flat_map(|account| {
            account.models.iter().filter_map(move |model| {
                let supports_text = model.capabilities.is_empty()
                    || model
                        .capabilities
                        .iter()
                        .any(|capability| capability.eq_ignore_ascii_case("text"));
                if !model.enabled || !supports_text {
                    return None;
                }
                let client_model = if model.alias.trim().is_empty() {
                    model.id.trim()
                } else {
                    model.alias.trim()
                };
                if client_model.is_empty() {
                    return None;
                }
                if !is_chat_test_model(client_model) {
                    return None;
                }
                Some((
                    test_provider_priority(&account.provider),
                    test_model_priority(client_model),
                    client_model.to_ascii_lowercase(),
                    client_model.to_string(),
                ))
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });

    let mut seen = BTreeSet::new();
    candidates
        .into_iter()
        .filter_map(|(_, _, normalized, model)| seen.insert(normalized).then_some(model))
        .take(3)
        .collect()
}

fn test_response_text(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    parsed
        .as_ref()
        .and_then(|value| value.pointer("/choices/0/message/content"))
        .and_then(Value::as_str)
        .or_else(|| {
            parsed
                .as_ref()
                .and_then(|value| value.pointer("/output/0/content/0/text"))
                .and_then(Value::as_str)
        })
        .unwrap_or(body)
        .chars()
        .take(2_000)
        .collect()
}

pub async fn test_chat(
    requested_model: Option<String>,
    requested_prompt: Option<String>,
) -> Result<MultiModelApiTestResult, String> {
    let mut state = get_state().await?;
    if !state.running {
        return Err("多模型 API 服务尚未启动".into());
    }
    if hydrate_managed_antigravity_credentials(&mut state.config).unwrap_or(false) {
        save_config_file(&state.config)?;
        write_managed_antigravity_auth_files(&state.config)?;
        // The sidecar watches auth files. Give it one short debounce window so
        // the UI's immediate test cannot race the credential reload.
        tokio::time::sleep(Duration::from_millis(180)).await;
    }
    let key = state
        .config
        .api_keys
        .iter()
        .find(|item| item.enabled && !item.key.trim().is_empty())
        .map(|item| item.key.trim().to_string())
        .ok_or("没有可用的下游 API Key")?;
    let requested_model = requested_model.unwrap_or_default().trim().to_string();
    let automatic = requested_model.is_empty();
    let models = if automatic {
        let models = automatic_chat_test_models(&state.config);
        if models.is_empty() {
            return Err("账号池中没有可测试的文本模型，请先同步或添加账号".into());
        }
        models
    } else {
        vec![requested_model]
    };
    let prompt = requested_prompt.unwrap_or_else(|| "Reply with exactly: gateway-ok".into());
    let endpoint = format!(
        "{}/v1/chat/completions",
        state.base_url.replace("0.0.0.0", "127.0.0.1")
    );
    let client = reqwest::Client::builder()
        // Loopback self-tests must bypass system/global proxies. Otherwise a
        // desktop proxy can turn a healthy local gateway into a false 502.
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|error| format!("创建网关测试客户端失败: {error}"))?;
    let overall_started = Instant::now();
    let mut failures = Vec::new();
    for model in &models {
        let started = Instant::now();
        let response = client
            .post(&endpoint)
            .bearer_auth(&key)
            .json(&json!({
                "model": model,
                "stream": false,
                "messages": [{"role": "user", "content": &prompt}]
            }))
            .send()
            .await
            .map_err(|error| format!("请求本地网关失败: {error}"))?;
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .map_err(|error| format!("读取网关测试响应失败: {error}"))?;
        let response_text = test_response_text(&body);
        let error = (!(200..300).contains(&status)).then(|| response_text.clone());
        let result = MultiModelApiTestResult {
            ok: error.is_none(),
            status,
            latency_ms: started.elapsed().as_millis() as u64,
            model: model.clone(),
            response: response_text,
            error,
        };
        if result.ok || !automatic {
            return Ok(result);
        }
        failures.push(result);
    }

    let mut result = failures
        .pop()
        .ok_or("账号池中没有可测试的文本模型，请先同步或添加账号")?;
    let attempted = models.join(", ");
    let detail = result
        .error
        .clone()
        .unwrap_or_else(|| result.response.clone());
    result.latency_ms = overall_started.elapsed().as_millis() as u64;
    result.response = format!("自动测试已依次尝试 {attempted}。最后响应：{detail}");
    result.error = Some(result.response.clone());
    Ok(result)
}

pub async fn sync_managed_accounts() -> Result<MultiModelApiState, String> {
    let mut config = load_config()?;
    // A provider account can be healthy enough for quota reads while its model
    // endpoint still requires an extra verification step. If the user disables
    // that route in the API account pool, a later "同步账号" must not silently
    // enable it again and reintroduce failed model calls.
    let previous_managed_enabled = config
        .accounts
        .iter()
        .filter(|account| account.source.starts_with("cle:"))
        .map(|account| (account.source.clone(), account.enabled))
        .collect::<BTreeMap<_, _>>();
    config
        .accounts
        .retain(|account| !account.source.starts_with("cle:"));

    if let Ok(accounts) = account::list_accounts() {
        for managed in accounts.into_iter().filter(|item| {
            !item.disabled
                && !item.quota.as_ref().is_some_and(|quota| quota.is_forbidden)
                && !item.quota_error.as_ref().is_some_and(|error| {
                    is_blocking_managed_route_error(None, Some(error.message.as_str()))
                })
        }) {
            if managed.token.access_token.trim().is_empty() {
                continue;
            }
            // The quota payload also contains aggregate buckets such as `3p-5h`
            // and `gemini-weekly`.  Those are counters, not routable model IDs.
            // Advertising them through /v1/models makes the UI look populated but
            // every request fails at the sidecar.  Keep only real model-shaped
            // entries and fall back to the models embedded in the active runtime.
            let discovered_models = managed
                .quota
                .as_ref()
                .map(|quota| {
                    quota
                        .models
                        .iter()
                        .map(|model| model.name.clone())
                        .filter(|model| is_routable_antigravity_model(model))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let models = models_or_defaults(discovered_models, DEFAULT_ANTIGRAVITY_MODELS);
            let source = format!("cle:antigravity:{}", managed.id);
            config.accounts.push(MultiModelAccount {
                id: format!("cle-antigravity-{}", managed.id),
                name: format!("Antigravity · {}", managed.email),
                provider: "antigravity".into(),
                auth_mode: "oauth_json".into(),
                base_url: String::new(),
                api_key: String::new(),
                credential_json: Some(json!({
                    "type": "antigravity",
                    "access_token": managed.token.access_token,
                    "refresh_token": managed.token.refresh_token,
                    "expires_in": managed.token.expires_in,
                    "expired": chrono::DateTime::from_timestamp(managed.token.expiry_timestamp, 0).map(|item| item.to_rfc3339()),
                    "email": managed.email,
                    "project_id": managed.token.project_id
                })),
                proxy_url: String::new(),
                prefix: String::new(),
                priority: 0,
                headers: BTreeMap::new(),
                models,
                enabled: previous_managed_enabled
                    .get(&source)
                    .copied()
                    .unwrap_or(true),
                source,
            });
        }
    }

    if let Ok(accounts) = codex_account::list_accounts_checked() {
        for account in accounts {
            if account.requires_reauth
                || (account.auth_mode == CodexAuthMode::OAuth
                    && account
                        .authorization_status
                        .as_deref()
                        .is_some_and(|status| {
                            status.eq_ignore_ascii_case("pending")
                                || status.eq_ignore_ascii_case("login_required")
                        }))
                || account.quota_error.as_ref().is_some_and(|error| {
                    is_blocking_managed_route_error(
                        error.code.as_deref(),
                        Some(error.message.as_str()),
                    )
                })
            {
                logger::log_warn(&format!(
                    "[MultiModelAPI] 跳过不可用 Codex 账号: id={}, email={}",
                    account.id, account.email
                ));
                continue;
            }
            let (auth_mode, api_key, credential_json) = match account.auth_mode {
                CodexAuthMode::Apikey => (
                    "api_key".into(),
                    account.openai_api_key.unwrap_or_default(),
                    None,
                ),
                CodexAuthMode::OAuth => (
                    "oauth_json".into(),
                    String::new(),
                    Some(json!({
                        "type": "codex",
                        "id_token": account.tokens.id_token,
                        "access_token": account.tokens.access_token,
                        "refresh_token": account.tokens.refresh_token.unwrap_or_default(),
                        "account_id": account.account_id.unwrap_or_else(|| account.id.clone()),
                        "email": account.email.clone()
                    })),
                ),
            };
            let source = format!("cle:codex:{}", account.id);
            config.accounts.push(MultiModelAccount {
                id: format!("cle-codex-{}", account.id),
                name: format!("Codex · {}", account.email),
                provider: "codex".into(),
                auth_mode,
                base_url: account.api_base_url.unwrap_or_default(),
                api_key,
                credential_json,
                proxy_url: String::new(),
                prefix: String::new(),
                priority: 0,
                headers: BTreeMap::new(),
                models: models_or_defaults(account.api_model_catalog, DEFAULT_CODEX_MODELS),
                enabled: previous_managed_enabled
                    .get(&source)
                    .copied()
                    .unwrap_or(true),
                source,
            });
        }
    }
    if let Ok(accounts) = gemini_account::list_accounts_checked() {
        for account in accounts {
            if is_blocking_managed_account_status(account.status.as_deref()) {
                logger::log_warn(&format!(
                    "[MultiModelAPI] 跳过需要验证或重新登录的 Gemini 账号: id={}, email={}",
                    account.id, account.email
                ));
                continue;
            }
            let discovered_models = gemini_account::extract_account_model_remaining(&account)
                .into_iter()
                .map(|(model, _remaining)| model)
                .collect::<Vec<_>>();
            let source = format!("cle:gemini:{}", account.id);
            config.accounts.push(MultiModelAccount {
                id: format!("cle-gemini-{}", account.id),
                name: format!("Gemini · {}", account.email),
                provider: "gemini".into(),
                auth_mode: "oauth_json".into(),
                base_url: String::new(),
                api_key: String::new(),
                credential_json: Some(json!({
                    "type": "gemini-cli",
                    "access_token": account.access_token,
                    "refresh_token": account.refresh_token.unwrap_or_default(),
                    "id_token": account.id_token.unwrap_or_default(),
                    "expiry_date": account.expiry_date,
                    "project_id": account.project_id,
                    "email": account.email.clone()
                })),
                proxy_url: String::new(),
                prefix: String::new(),
                priority: 0,
                headers: BTreeMap::new(),
                models: models_or_defaults(discovered_models, DEFAULT_GEMINI_MODELS),
                enabled: previous_managed_enabled
                    .get(&source)
                    .copied()
                    .unwrap_or(true),
                source,
            });
        }
    }
    if let Ok(accounts) = claude_account::list_accounts_checked() {
        for account in accounts {
            if is_blocking_managed_account_status(account.status.as_deref()) {
                logger::log_warn(&format!(
                    "[MultiModelAPI] 跳过需要验证或重新登录的 Claude 账号: id={}, email={}",
                    account.id, account.email
                ));
                continue;
            }
            if matches!(
                account.auth_mode,
                ClaudeAuthMode::DesktopOAuth | ClaudeAuthMode::DesktopGateway
            ) {
                let Some(profile_dir) = account.desktop_profile_dir.as_deref() else {
                    continue;
                };
                let auth_export_path =
                    Path::new(profile_dir).join("claude_desktop_auth_export.json");
                if !auth_export_path.is_file() {
                    continue;
                }
                let source = format!("cle:claude-web:{}", account.id);
                config.accounts.push(MultiModelAccount {
                    id: format!("cle-claude-web-{}", account.id),
                    name: format!("Claude Web 路 {}", account.email),
                    provider: "claude-web".into(),
                    auth_mode: "oauth_json".into(),
                    base_url: "https://claude.ai".into(),
                    api_key: String::new(),
                    credential_json: Some(json!({
                        "type": "claude-web",
                        "auth_export_path": auth_export_path.to_string_lossy()
                    })),
                    proxy_url: String::new(),
                    prefix: String::new(),
                    priority: 0,
                    headers: BTreeMap::new(),
                    models: models_or_defaults(Vec::new(), DEFAULT_CLAUDE_WEB_MODELS),
                    enabled: previous_managed_enabled
                        .get(&source)
                        .copied()
                        .unwrap_or(true),
                    source,
                });
                continue;
            }
            let is_api_key = matches!(account.auth_mode, ClaudeAuthMode::ApiKey);
            let credential_json = if is_api_key {
                None
            } else {
                account.claude_credentials_raw.as_ref().and_then(|raw| {
                    let oauth = raw.get("claudeAiOauth")?;
                    Some(json!({
                        "type": "claude",
                        "access_token": oauth.get("accessToken").cloned().unwrap_or(Value::Null),
                        "refresh_token": oauth.get("refreshToken").cloned().unwrap_or(Value::Null),
                        "expired": oauth.get("expiresAt").cloned().unwrap_or(Value::Null),
                        "email": account.email.clone()
                    }))
                })
            };
            let api_key = account.api_key.clone().unwrap_or_default();
            if api_key.trim().is_empty() && credential_json.is_none() {
                continue;
            }
            let source = format!("cle:claude:{}", account.id);
            config.accounts.push(MultiModelAccount {
                id: format!("cle-claude-{}", account.id),
                name: format!("Claude · {}", account.email),
                provider: "claude".into(),
                auth_mode: if is_api_key {
                    "api_key".into()
                } else {
                    "oauth_json".into()
                },
                base_url: account.api_base_url.unwrap_or_default(),
                api_key,
                credential_json,
                proxy_url: String::new(),
                prefix: String::new(),
                priority: 0,
                headers: BTreeMap::new(),
                models: models_or_defaults(
                    account.api_model_catalog.unwrap_or_default(),
                    DEFAULT_CLAUDE_MODELS,
                ),
                enabled: previous_managed_enabled
                    .get(&source)
                    .copied()
                    .unwrap_or(true),
                source,
            });
        }
    }
    save_config(config).await
}

const DEFAULT_CODEX_MODELS: &[&str] = &[
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-image-2",
    "codex-auto-review",
];

const DEFAULT_ANTIGRAVITY_MODELS: &[&str] = &[
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "gemini-3-flash",
    "gemini-3-flash-agent",
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3.1-flash-image",
    "gemini-pro-agent",
    "gemini-3.1-pro-low",
    "gpt-oss-120b-medium",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-low",
    "veo-3.1-generate-preview",
];

const DEFAULT_GEMINI_MODELS: &[&str] = &[
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "veo-3.1-generate-preview",
    "veo-3.0-generate-preview",
];

const DEFAULT_CLAUDE_MODELS: &[&str] = &[
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-5-20251101",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-haiku-20241022",
];

const DEFAULT_CLAUDE_WEB_MODELS: &[&str] = &[
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-3-7-sonnet-latest",
    "claude-3-5-haiku-latest",
];

fn models_or_defaults(models: Vec<String>, defaults: &[&str]) -> Vec<MultiModelDefinition> {
    let source = if models.is_empty() {
        defaults.iter().map(|model| (*model).to_string()).collect()
    } else {
        models
    };
    source.into_iter().map(model_definition).collect()
}

fn is_routable_antigravity_model(model: &str) -> bool {
    let normalized = model.trim().to_ascii_lowercase();
    !(normalized.is_empty()
        || normalized.starts_with("3p-")
        || normalized.ends_with("-weekly")
        || normalized.ends_with("-5h"))
}

fn is_blocking_managed_account_status(status: Option<&str>) -> bool {
    status.is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "verification_required"
                | "login_required"
                | "reauth_required"
                | "forbidden"
                | "banned"
                | "deactivated"
        )
    })
}

fn is_blocking_managed_route_error(code: Option<&str>, message: Option<&str>) -> bool {
    let combined = format!(
        "{} {}",
        code.unwrap_or_default(),
        message.unwrap_or_default()
    )
    .to_ascii_lowercase();
    [
        "deactivated_workspace",
        "validation_required",
        "verification_required",
        "login_required",
        "invalid_grant",
        "workspace has been deactivated",
        "工作区已停用",
        "需要验证",
    ]
    .iter()
    .any(|marker| combined.contains(marker))
}

fn model_definition(id: String) -> MultiModelDefinition {
    let normalized = id.to_ascii_lowercase();
    let capabilities = if normalized.contains("video")
        || normalized.starts_with("veo-")
        || normalized.contains("seedance")
    {
        vec!["video".into()]
    } else if normalized.contains("image") || normalized.contains("imagen") {
        vec!["image".into(), "vision".into()]
    } else if normalized.contains("thinking")
        || normalized.contains("reasoning")
        || normalized.contains("pro")
        || normalized.contains("gpt-5")
    {
        vec!["text".into(), "vision".into(), "reasoning".into()]
    } else {
        vec!["text".into(), "vision".into()]
    };
    MultiModelDefinition {
        id,
        alias: String::new(),
        capabilities,
        enabled: true,
    }
}

pub async fn restore() {
    match load_config() {
        Ok(config) if config.enabled => {
            if let Err(error) = start_runtime(&config, true).await {
                logger::log_warn(&format!("[MultiModelAPI] 恢复失败: {error}"));
                runtime().lock().await.last_error = Some(error);
            }
        }
        Ok(_) => {}
        Err(error) => logger::log_warn(&format!("[MultiModelAPI] 读取配置失败: {error}")),
    }
    start_runtime_watchdog();
}

pub fn start_runtime_watchdog() {
    if WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(WATCHDOG_INTERVAL_SECONDS)).await;
            let mut config = match load_config() {
                Ok(config) if config.enabled => config,
                Ok(_) => continue,
                Err(error) => {
                    logger::log_warn(&format!(
                        "[MultiModelAPI][watchdog] 读取配置失败，等待下一轮自动恢复: {error}"
                    ));
                    continue;
                }
            };
            match hydrate_managed_antigravity_credentials(&mut config) {
                Ok(true) => {
                    if let Err(error) = save_config_file(&config)
                        .and_then(|_| write_managed_antigravity_auth_files(&config))
                    {
                        logger::log_warn(&format!(
                            "[MultiModelAPI][watchdog] 更新 Antigravity 运行凭据失败: {error}"
                        ));
                    } else {
                        logger::log_info(
                            "[MultiModelAPI][watchdog] 已热同步 Antigravity 最新账号凭据",
                        );
                    }
                }
                Ok(false) => {}
                Err(error) => logger::log_warn(&format!(
                    "[MultiModelAPI][watchdog] 读取 Antigravity 最新账号凭据失败: {error}"
                )),
            }
            let probe_error = match probe_gateway(&config).await {
                Ok(_) => {
                    record_health_success(false).await;
                    continue;
                }
                Err(error) => error,
            };
            let consecutive_failures = record_health_failure(probe_error.clone()).await;
            logger::log_warn(&format!(
                "[MultiModelAPI][watchdog] 健康检查失败 {consecutive_failures}/{WATCHDOG_FAILURE_THRESHOLD}: {probe_error}"
            ));
            if consecutive_failures < WATCHDOG_FAILURE_THRESHOLD {
                continue;
            }

            let should_restart = {
                let mut state = self_heal_runtime().lock().await;
                if state
                    .next_restart_after
                    .is_some_and(|deadline| deadline > Instant::now())
                {
                    false
                } else {
                    let delay = watchdog_restart_delay(state.restart_failures);
                    state.restart_attempts = state.restart_attempts.saturating_add(1);
                    state.next_restart_after = Some(Instant::now() + delay);
                    state.next_restart_at = Some(
                        (chrono::Utc::now() + chrono::Duration::seconds(delay.as_secs() as i64))
                            .to_rfc3339(),
                    );
                    true
                }
            };
            if !should_restart {
                continue;
            }

            let _repair_guard = repair_lifecycle().lock().await;
            logger::log_warn(
                "[MultiModelAPI][watchdog] 连续健康检查失败，正在串行自动恢复 sidecar",
            );
            match start_runtime(&config, false).await {
                Ok(()) => {
                    record_health_success(true).await;
                    logger::log_info("[MultiModelAPI][watchdog] sidecar 已自动恢复并重新监听");
                }
                Err(error) => {
                    logger::log_warn(&format!("[MultiModelAPI][watchdog] 自动恢复失败: {error}"));
                    {
                        let mut heal = self_heal_runtime().lock().await;
                        heal.restart_failures = heal.restart_failures.saturating_add(1);
                        heal.last_error = Some(error.clone());
                        let delay = watchdog_restart_delay(heal.restart_failures);
                        heal.next_restart_after = Some(Instant::now() + delay);
                        heal.next_restart_at = Some(
                            (chrono::Utc::now()
                                + chrono::Duration::seconds(delay.as_secs() as i64))
                            .to_rfc3339(),
                        );
                    }
                    runtime().lock().await.last_error = Some(error);
                }
            }
        }
    });
}

pub async fn shutdown() {
    let _lifecycle_guard = lifecycle().lock().await;
    let mut state = runtime().lock().await;
    stop_runtime_locked(&mut state).await;
}

#[cfg(test)]
mod tests {
    use super::{
        automatic_chat_test_models, builtin_catalog, default_config,
        is_blocking_managed_account_status, is_blocking_managed_route_error,
        is_routable_antigravity_model, model_definition, normalize_config,
        normalize_oauth_credential, normalize_provider, provider_chat_test_models,
        watchdog_restart_delay, MultiModelAccount, MultiModelDefinition,
    };
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn clamps_retry_budget_to_safe_failover_range() {
        let mut disabled = default_config();
        disabled.request_retries = 0;
        normalize_config(&mut disabled).expect("normalize zero retries");
        assert_eq!(disabled.request_retries, 1);

        let mut excessive = default_config();
        excessive.request_retries = u8::MAX;
        normalize_config(&mut excessive).expect("normalize excessive retries");
        assert_eq!(excessive.request_retries, 4);
    }

    #[test]
    fn seedance_is_a_native_video_provider_in_the_unified_gateway() {
        assert_eq!(normalize_provider("doubao_seedance"), "doubao-seedance");
        let models = builtin_catalog()
            .into_iter()
            .filter(|item| item.provider == "doubao-seedance")
            .collect::<Vec<_>>();
        assert_eq!(models.len(), 2);
        assert!(models.iter().all(|item| item.capabilities == ["video"]));
    }

    #[test]
    fn antigravity_sync_keeps_new_official_models_but_rejects_aggregate_buckets() {
        assert!(is_routable_antigravity_model("imagen-4-ultra"));
        assert!(is_routable_antigravity_model("future-provider-model-v1"));
        assert!(!is_routable_antigravity_model("3p-5h"));
        assert!(!is_routable_antigravity_model("gemini-weekly"));
        assert!(!is_routable_antigravity_model("claude-5h"));

        let image = model_definition("imagen-4-ultra".to_string());
        assert_eq!(image.capabilities, ["image", "vision"]);
    }

    #[test]
    fn managed_sync_excludes_accounts_blocked_by_auth_or_workspace_state() {
        assert!(is_blocking_managed_account_status(Some(
            "verification_required"
        )));
        assert!(is_blocking_managed_account_status(Some("login_required")));
        assert!(!is_blocking_managed_account_status(Some("normal")));
        assert!(is_blocking_managed_route_error(
            Some("deactivated_workspace"),
            None
        ));
        assert!(is_blocking_managed_route_error(
            None,
            Some("Google returned VALIDATION_REQUIRED")
        ));
        assert!(!is_blocking_managed_route_error(
            None,
            Some("temporary upstream HTTP 503")
        ));
    }

    #[test]
    fn watchdog_restart_backoff_is_bounded() {
        assert_eq!(watchdog_restart_delay(0), Duration::from_secs(30));
        assert_eq!(watchdog_restart_delay(1), Duration::from_secs(60));
        assert_eq!(watchdog_restart_delay(3), Duration::from_secs(240));
        assert_eq!(watchdog_restart_delay(10), Duration::from_secs(300));
    }

    #[test]
    fn normalizes_xai_oauth_for_native_executor() {
        let credential = normalize_oauth_credential(
            "xai",
            json!({
                "type": "xai",
                "access_token": "access",
                "refresh_token": "refresh",
                "token_url": "https://auth.x.ai/oauth2/token"
            }),
        );
        assert_eq!(credential["type"], "xai");
        assert_eq!(credential["auth_kind"], "oauth");
        assert_eq!(
            credential["token_endpoint"],
            "https://auth.x.ai/oauth2/token"
        );
    }

    #[test]
    fn normalizes_gemini_expiry_and_nested_token() {
        let credential = normalize_oauth_credential(
            "gemini",
            json!({
                "type": "gemini-cli",
                "access_token": "access",
                "refresh_token": "refresh",
                "expiry_date": 1_784_609_282_222_i64
            }),
        );
        assert_eq!(credential["type"], "gemini-cli");
        assert_eq!(credential["expiry"], "2026-07-21T04:48:02.222+00:00");
        assert_eq!(credential["token"]["access_token"], "access");
        assert_eq!(credential["token"]["refresh_token"], "refresh");
        assert_eq!(
            credential["token"]["expiry"],
            "2026-07-21T04:48:02.222+00:00"
        );
    }

    #[test]
    fn automatic_chat_test_prefers_stable_codex_text_model_over_first_xai_account() {
        let model = |id: &str, capabilities: &[&str]| MultiModelDefinition {
            id: id.to_string(),
            alias: String::new(),
            capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
            enabled: true,
        };
        let account = |provider: &str, models: Vec<MultiModelDefinition>| MultiModelAccount {
            id: provider.to_string(),
            name: provider.to_string(),
            provider: provider.to_string(),
            auth_mode: "oauth_json".to_string(),
            base_url: String::new(),
            api_key: String::new(),
            credential_json: None,
            proxy_url: String::new(),
            prefix: String::new(),
            priority: 0,
            headers: Default::default(),
            models,
            enabled: true,
            source: String::new(),
        };
        let mut config = default_config();
        config.accounts = vec![
            account("xai", vec![model("grok-4.3", &["text"])]),
            account(
                "codex",
                vec![
                    model("gpt-image-2", &["image"]),
                    model("codex-auto-review", &["text"]),
                    model("gpt-5.5", &["text"]),
                    model("gpt-5.4-mini", &["text"]),
                ],
            ),
        ];

        let candidates = automatic_chat_test_models(&config);
        assert_eq!(candidates.first().map(String::as_str), Some("gpt-5.4-mini"));
        assert!(!candidates.iter().any(|model| model == "gpt-image-2"));
        assert!(!candidates.iter().any(|model| model == "codex-auto-review"));
    }

    #[test]
    fn provider_chat_tests_choose_one_unique_text_model_per_provider() {
        let model = |id: &str, capabilities: &[&str]| MultiModelDefinition {
            id: id.to_string(),
            alias: String::new(),
            capabilities: capabilities.iter().map(|value| value.to_string()).collect(),
            enabled: true,
        };
        let account = |provider: &str, models: Vec<MultiModelDefinition>| MultiModelAccount {
            id: provider.to_string(),
            name: provider.to_string(),
            provider: provider.to_string(),
            auth_mode: "oauth_json".to_string(),
            base_url: String::new(),
            api_key: String::new(),
            credential_json: None,
            proxy_url: String::new(),
            prefix: String::new(),
            priority: 0,
            headers: Default::default(),
            models,
            enabled: true,
            source: String::new(),
        };
        let mut config = default_config();
        config.accounts = vec![
            account(
                "codex",
                vec![
                    model("shared-chat", &["text"]),
                    model("gpt-5.4-mini", &["text"]),
                    model("gpt-image-2", &["image"]),
                ],
            ),
            account(
                "gemini",
                vec![
                    model("shared-chat", &["text"]),
                    model("gemini-3-flash", &["text"]),
                ],
            ),
        ];

        assert_eq!(
            provider_chat_test_models(&config),
            vec![
                ("codex".to_string(), "gpt-5.4-mini".to_string()),
                ("gemini".to_string(), "gemini-3-flash".to_string()),
            ]
        );
    }
}
