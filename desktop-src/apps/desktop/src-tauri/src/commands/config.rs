use std::{fs, path::Path};

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_paths,
    sidecar::{start_sidecar, stop_sidecar, wait_until_ready, SidecarManager},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionAccount {
    pub id: String,
    pub label: String,
    pub session_key: String,
    pub proxy_url: Option<String>,
    pub enabled: bool,
    pub daily_limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionRuntimeState {
    pub account_id: String,
    pub status: String,
    pub today_calls: u32,
    pub cooldown_until: Option<String>,
    pub retry_after_until: Option<String>,
    pub last_error: Option<String>,
    pub last_success_at: Option<String>,
    pub last_failure_kind: Option<String>,
    pub last_status_code: Option<u16>,
    pub last_transport: Option<String>,
    pub consecutive_failures: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayConfig {
    pub enabled: bool,
    pub listen_host: String,
    pub listen_port: u16,
    pub upstream_base_url: Option<String>,
    pub transport_mode: String,
    pub helper_mode: String,
    pub probe_before_start: bool,
    pub prefer_browser_on_403: bool,
    pub respect_retry_after: bool,
    pub stream_first_chunk_timeout_ms: u32,
    pub max_retries: u32,
    pub cooldown_minutes: u32,
    pub claude_daily_limit: u32,
    pub require_api_key: bool,
    pub local_api_key: Option<String>,
    pub accounts: Vec<ClaudeSessionAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub listen_host: String,
    pub listen_port: u16,
    pub api_base_url: String,
    pub upstream_base_url: String,
    pub transport_mode: String,
    pub helper_mode: String,
    pub supports_streaming: bool,
    pub sidecar_pid: Option<u32>,
    pub last_error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthExportStatus {
    pub version: u32,
    pub status: String,
    pub authenticated: bool,
    pub exported_at: Option<String>,
    pub user_data_dir: Option<String>,
    pub cookie_names: Option<Vec<String>>,
    pub has_session_key: Option<bool>,
    pub has_last_active_org: Option<bool>,
    pub url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub owned_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListResponse {
    pub object: String,
    pub data: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewaySnapshot {
    pub config: GatewayConfig,
    pub status: GatewayStatus,
    pub runtime_states: Vec<ClaudeSessionRuntimeState>,
    pub auth_status: Option<AuthExportStatus>,
    pub models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchImportResult {
    pub inserted: usize,
    pub skipped: usize,
    pub items: Vec<ClaudeSessionAccount>,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn write_json_pretty<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let data = serde_json::to_vec_pretty(value)?;
    fs::write(path, data)?;
    Ok(())
}

pub fn default_gateway_config() -> GatewayConfig {
    GatewayConfig {
        enabled: false,
        listen_host: "127.0.0.1".into(),
        listen_port: 8787,
        upstream_base_url: Some("https://claude.ai".into()),
        transport_mode: "direct_http".into(),
        helper_mode: "probe_only".into(),
        probe_before_start: false,
        prefer_browser_on_403: true,
        respect_retry_after: true,
        stream_first_chunk_timeout_ms: 8_000,
        max_retries: 3,
        cooldown_minutes: 15,
        claude_daily_limit: 100,
        require_api_key: false,
        local_api_key: Some(String::new()),
        accounts: Vec::new(),
    }
}

fn normalize_transport_mode(value: &str) -> String {
    match value.trim() {
        "browser_bridge" => "browser_bridge".into(),
        "auto" => "auto".into(),
        _ => "direct_http".into(),
    }
}

fn normalize_helper_mode(value: &str) -> String {
    match value.trim() {
        "disabled" => "disabled".into(),
        "browser_fetch" => "browser_fetch".into(),
        "page_context" => "page_context".into(),
        _ => "probe_only".into(),
    }
}

pub fn normalize_gateway_config(mut config: GatewayConfig) -> GatewayConfig {
    config.listen_host = if config.listen_host.trim().is_empty() {
        "127.0.0.1".into()
    } else {
        config.listen_host.trim().to_string()
    };
    config.listen_port = config.listen_port.clamp(1, 65535);
    config.upstream_base_url = config
        .upstream_base_url
        .as_ref()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| Some("https://claude.ai".into()));
    config.transport_mode = normalize_transport_mode(&config.transport_mode);
    config.helper_mode = normalize_helper_mode(&config.helper_mode);
    config.stream_first_chunk_timeout_ms = config.stream_first_chunk_timeout_ms.clamp(1_000, 120_000);
    config.max_retries = config.max_retries.clamp(1, 20);
    config.cooldown_minutes = config.cooldown_minutes.clamp(1, 1440);
    config.claude_daily_limit = config.claude_daily_limit.clamp(1, 100_000);

    for (index, account) in config.accounts.iter_mut().enumerate() {
        if account.id.trim().is_empty() {
            account.id = format!("acct_{index}");
        }
        if account.label.trim().is_empty() {
            account.label = format!("Claude Web {}", index + 1);
        }
        account.session_key = account.session_key.trim().to_string();
        account.proxy_url = account
            .proxy_url
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        account.daily_limit = Some(account.daily_limit.unwrap_or(config.claude_daily_limit).max(1));
    }

    config.accounts.retain(|account| !account.session_key.is_empty());
    config
}

pub fn load_gateway_config() -> Result<GatewayConfig> {
    let path = app_paths::gateway_config_path()?;
    if !path.exists() {
        let default = default_gateway_config();
        write_json_pretty(&path, &default)?;
        return Ok(default);
    }

    let raw = fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let config = serde_json::from_str::<GatewayConfig>(&raw)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    Ok(normalize_gateway_config(config))
}

pub fn save_gateway_config_inner(config: &GatewayConfig) -> Result<GatewayConfig> {
    let normalized = normalize_gateway_config(config.clone());
    let path = app_paths::gateway_config_path()?;
    write_json_pretty(&path, &normalized)?;
    Ok(normalized)
}

pub fn load_auth_status() -> Result<Option<AuthExportStatus>> {
    let path = app_paths::auth_status_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str::<AuthExportStatus>(&raw)?))
}

pub fn write_auth_status(status: &AuthExportStatus) -> Result<()> {
    let path = app_paths::auth_status_path()?;
    write_json_pretty(&path, status)
}

pub fn load_runtime_states() -> Result<Vec<ClaudeSessionRuntimeState>> {
    let path = app_paths::sidecar_runtime_state_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)?;
    Ok(serde_json::from_str::<Vec<ClaudeSessionRuntimeState>>(&raw).unwrap_or_default())
}

pub fn save_runtime_states(states: &[ClaudeSessionRuntimeState]) -> Result<()> {
    let path = app_paths::sidecar_runtime_state_path()?;
    write_json_pretty(&path, &states)
}

pub fn default_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "claude-sonnet-5".into(),
            object: "model".into(),
            created: 0,
            owned_by: "claude-web".into(),
        },
        ModelInfo {
            id: "claude-haiku-4-5".into(),
            object: "model".into(),
            created: 0,
            owned_by: "claude-web".into(),
        },
        ModelInfo {
            id: "claude-3-7-sonnet-latest".into(),
            object: "model".into(),
            created: 0,
            owned_by: "claude-web".into(),
        },
        ModelInfo {
            id: "claude-3-5-haiku-latest".into(),
            object: "model".into(),
            created: 0,
            owned_by: "claude-web".into(),
        },
    ]
}

pub fn build_gateway_status(
    config: &GatewayConfig,
    running: bool,
    sidecar_pid: Option<u32>,
    last_error: Option<String>,
) -> GatewayStatus {
    GatewayStatus {
        running,
        listen_host: config.listen_host.clone(),
        listen_port: config.listen_port,
        api_base_url: format!("http://{}:{}/v1", config.listen_host, config.listen_port),
        upstream_base_url: config
            .upstream_base_url
            .clone()
            .unwrap_or_else(|| "https://claude.ai".into()),
        transport_mode: config.transport_mode.clone(),
        helper_mode: config.helper_mode.clone(),
        supports_streaming: true,
        sidecar_pid,
        last_error,
        updated_at: now_iso(),
    }
}

pub fn batch_import_session_keys(raw: &str, config: &mut GatewayConfig) -> BatchImportResult {
    let mut inserted = 0usize;
    let mut skipped = 0usize;
    let mut known = config
        .accounts
        .iter()
        .map(|account| account.session_key.clone())
        .collect::<std::collections::HashSet<_>>();

    for (index, token) in raw
        .split(|ch| ch == '\n' || ch == ',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .enumerate()
    {
        if known.contains(token) {
            skipped += 1;
            continue;
        }
        known.insert(token.to_string());
        inserted += 1;
        config.accounts.push(ClaudeSessionAccount {
            id: format!("imported_{}_{}", Utc::now().timestamp(), index),
            label: format!("Claude Web {}", config.accounts.len() + 1),
            session_key: token.to_string(),
            proxy_url: None,
            enabled: true,
            daily_limit: Some(config.claude_daily_limit),
        });
    }

    BatchImportResult {
        inserted,
        skipped,
        items: config.accounts.clone(),
    }
}

#[tauri::command]
pub fn save_gateway_config(
    config: GatewayConfig,
    sidecar: State<'_, SidecarManager>,
) -> Result<GatewaySnapshot, String> {
    let saved = save_gateway_config_inner(&config).map_err(|error| error.to_string())?;
    let (was_running, _, _) = sidecar.snapshot();

    let status = if was_running {
        stop_sidecar(&sidecar).map_err(|error| error.to_string())?;
        let (_running, pid) = start_sidecar(&sidecar, &saved).map_err(|error| error.to_string())?;
        wait_until_ready(&saved).map_err(|error| error.to_string())?;
        let (running, _, last_error) = sidecar.snapshot();
        build_gateway_status(&saved, running, pid, last_error)
    } else {
        build_gateway_status(&saved, false, None, None)
    };

    Ok(GatewaySnapshot {
        status,
        config: saved,
        runtime_states: load_runtime_states().unwrap_or_default(),
        auth_status: load_auth_status().unwrap_or(None),
        models: default_models(),
    })
}

#[tauri::command]
pub fn import_session_keys(raw: String) -> Result<BatchImportResult, String> {
    let mut config = load_gateway_config().map_err(|error| error.to_string())?;
    let result = batch_import_session_keys(&raw, &mut config);
    let _ = save_gateway_config_inner(&config).map_err(|error| error.to_string())?;
    Ok(result)
}
