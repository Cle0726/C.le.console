use std::{path::PathBuf, process::Command};

use anyhow::{anyhow, Result};

use crate::{
    app_paths,
    commands::config::{load_auth_status, now_iso, write_auth_status, AuthExportStatus},
};

pub(crate) fn repo_root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    root.canonicalize().unwrap_or(root)
}

fn helper_script(root: &PathBuf, file_name: &str) -> Result<PathBuf> {
    let path = root.join("tools").join("auth-helper").join(file_name);
    if path.exists() {
        Ok(path)
    } else {
        Err(anyhow!("helper script not found: {file_name}"))
    }
}

fn desktop_auth_helper_script_path() -> Result<PathBuf> {
    helper_script(&repo_root(), "claude-desktop-auth-helper.cjs")
}

pub(crate) fn browser_bridge_script_path() -> Result<PathBuf> {
    helper_script(&repo_root(), "claude-browser-bridge.cjs")
}

fn electron_installation_ready(root: &PathBuf) -> bool {
    let electron_dir = root.join("node_modules").join("electron");
    electron_dir.join("path.txt").exists() && electron_dir.join("dist").join("electron.exe").exists()
}

pub(crate) struct ElectronLaunch {
    pub(crate) binary: PathBuf,
    pub(crate) override_dist: Option<PathBuf>,
}

fn vendored_electron_dist_path(root: &PathBuf) -> Option<PathBuf> {
    let candidate = root.join("tools").join("auth-helper").join("electron-runtime");
    candidate
        .join(if cfg!(windows) { "electron.exe" } else { "electron" })
        .exists()
        .then_some(candidate)
}

pub(crate) fn electron_launch() -> Result<ElectronLaunch> {
    let root = repo_root();
    let bin_name = if cfg!(windows) { "electron.cmd" } else { "electron" };
    let candidates = [
        root.join("node_modules").join(".bin").join(bin_name),
        root.join("tools").join("auth-helper").join("node_modules").join(".bin").join(bin_name),
    ];

    let binary = candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| anyhow!("electron binary not found; run npm install in desktop-src first"))?;

    if electron_installation_ready(&root) {
        return Ok(ElectronLaunch {
            binary,
            override_dist: None,
        });
    }

    if let Some(override_dist) = vendored_electron_dist_path(&root) {
        return Ok(ElectronLaunch {
            binary,
            override_dist: Some(override_dist),
        });
    }

    Err(anyhow!(
        "electron dependency is present but not fully installed; run npm rebuild electron --foreground-scripts in desktop-src, or keep tools/auth-helper/electron-runtime available"
    ))
}

#[tauri::command]
pub fn launch_claude_login() -> Result<AuthExportStatus, String> {
    let status = AuthExportStatus {
        version: 1,
        status: "starting".into(),
        authenticated: false,
        exported_at: Some(now_iso()),
        user_data_dir: Some(app_paths::helper_user_data_dir().map_err(|error| error.to_string())?.display().to_string()),
        cookie_names: Some(Vec::new()),
        has_session_key: Some(false),
        has_last_active_org: Some(false),
        url: None,
        error: None,
    };
    write_auth_status(&status).map_err(|error| error.to_string())?;

    let electron = electron_launch().map_err(|error| error.to_string())?;
    let script = desktop_auth_helper_script_path().map_err(|error| error.to_string())?;
    let user_data_dir = app_paths::helper_user_data_dir().map_err(|error| error.to_string())?;
    let status_file = app_paths::auth_status_path().map_err(|error| error.to_string())?;
    let export_file = app_paths::auth_export_path().map_err(|error| error.to_string())?;
    let cookie_file = app_paths::auth_cookie_path().map_err(|error| error.to_string())?;

    let mut command = Command::new(electron.binary);
    command.env_remove("ELECTRON_RUN_AS_NODE");
    if let Some(override_dist) = electron.override_dist {
        command.env("ELECTRON_OVERRIDE_DIST_PATH", override_dist);
    }

    command
        .arg(script)
        .arg("--user-data-dir")
        .arg(user_data_dir)
        .arg("--status-file")
        .arg(status_file)
        .arg("--export-file")
        .arg(export_file)
        .arg("--cookie-file")
        .arg(cookie_file)
        .spawn()
        .map_err(|error| error.to_string())?;

    load_auth_status()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "failed to load auth status after helper launch".to_string())
}

#[tauri::command]
pub fn get_auth_status() -> Result<Option<AuthExportStatus>, String> {
    load_auth_status().map_err(|error| error.to_string())
}
