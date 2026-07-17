use std::path::PathBuf;

use anyhow::{Context, Result};

const APP_DIR_NAME: &str = "claude-web-gateway-desktop";

pub fn runtime_dir() -> Result<PathBuf> {
    let base = dirs::data_local_dir().context("failed to resolve local data directory")?;
    let dir = base.join(APP_DIR_NAME);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn logs_dir() -> Result<PathBuf> {
    let dir = runtime_dir()?.join("logs");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn helper_user_data_dir() -> Result<PathBuf> {
    let dir = runtime_dir()?.join("claude-auth-user-data");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn gateway_config_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("gateway-config.json"))
}

pub fn sidecar_config_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("sidecar-config.json"))
}

pub fn sidecar_runtime_state_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("sidecar-runtime-state.json"))
}

pub fn auth_status_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("claude-auth-status.json"))
}

pub fn auth_export_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("claude-auth-export.json"))
}

pub fn auth_cookie_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("claude-auth-cookies.json"))
}

pub fn browser_bridge_state_path() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("claude-browser-bridge-state.json"))
}
