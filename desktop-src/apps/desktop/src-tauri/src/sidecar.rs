use std::{
    fs::OpenOptions,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::Client;
use tauri::State;

use crate::{
    app_paths,
    commands::{
        auth_helper::{browser_bridge_script_path, electron_launch, repo_root, ElectronLaunch},
        config::{
            default_models, load_runtime_states, save_runtime_states, ClaudeSessionRuntimeState, GatewayConfig,
            ModelInfo, ModelListResponse,
        },
    },
};

const BRIDGE_ENV_URL: &str = "COCKPIT_BROWSER_BRIDGE_URL";
const BRIDGE_ENV_TOKEN: &str = "COCKPIT_BROWSER_BRIDGE_TOKEN";
const BRIDGE_ENV_STATE_FILE: &str = "COCKPIT_BROWSER_BRIDGE_STATE_FILE";
const BRIDGE_TRANSPORT: &str = "browser_bridge";

#[derive(Default)]
pub struct SidecarManager {
    sidecar_child: Mutex<Option<Child>>,
    browser_bridge_child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
}

impl SidecarManager {
    fn set_last_error(&self, message: impl Into<String>) {
        *self.last_error.lock().expect("sidecar error mutex poisoned") = Some(message.into());
    }

    fn clear_last_error(&self) {
        *self.last_error.lock().expect("sidecar error mutex poisoned") = None;
    }

    fn poll_child(&self, slot: &mut Option<Child>, label: &str) {
        if let Some(child) = slot.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.set_last_error(format!("{label} exited: {status}"));
                    *slot = None;
                }
                Ok(None) => {}
                Err(error) => {
                    self.set_last_error(format!("failed to poll {label}: {error}"));
                    *slot = None;
                }
            }
        }
    }

    pub fn snapshot(&self) -> (bool, Option<u32>, Option<String>) {
        let mut running = false;
        let mut pid = None;

        {
            let mut bridge_guard = self.browser_bridge_child.lock().expect("bridge mutex poisoned");
            self.poll_child(&mut bridge_guard, "browser bridge");
        }

        {
            let mut sidecar_guard = self.sidecar_child.lock().expect("sidecar mutex poisoned");
            self.poll_child(&mut sidecar_guard, "sidecar");
            if let Some(child) = sidecar_guard.as_mut() {
                running = true;
                pid = Some(child.id());
            }
        }

        let last_error = self
            .last_error
            .lock()
            .expect("sidecar error mutex poisoned")
            .clone();
        (running, pid, last_error)
    }
}

struct BrowserBridgeLaunch {
    url: String,
    token: String,
    state_file: PathBuf,
}

fn sidecar_binary_path() -> Result<PathBuf> {
    let root = repo_root();
    let bin_name = if cfg!(windows) { "cockpit-cliproxy.exe" } else { "cockpit-cliproxy" };
    let candidates = [
        root.join("sidecars").join("cockpit-cliproxy").join("bin").join(bin_name),
        root.join("sidecars").join("cockpit-cliproxy").join(bin_name),
    ];

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| anyhow!("sidecar binary not found; build sidecars/cockpit-cliproxy first"))
}

fn write_sidecar_config(config: &GatewayConfig) -> Result<PathBuf> {
    let path = app_paths::sidecar_config_path()?;
    let data = serde_json::to_vec_pretty(config)?;
    std::fs::write(&path, data)?;
    Ok(path)
}

fn health_url(config: &GatewayConfig) -> String {
    format!("http://{}:{}/healthz", config.listen_host, config.listen_port)
}

fn models_url(config: &GatewayConfig) -> String {
    format!("http://{}:{}/v1/models", config.listen_host, config.listen_port)
}

fn runtime_url(config: &GatewayConfig) -> String {
    format!("http://{}:{}/_gateway/runtime", config.listen_host, config.listen_port)
}

fn http_client() -> Result<Client> {
    Ok(Client::builder().no_proxy().build()?)
}

fn normalize_transport_mode(config: &GatewayConfig) -> &str {
    match config.transport_mode.trim() {
        "browser_bridge" => "browser_bridge",
        "auto" => "auto",
        _ => "direct_http",
    }
}

fn normalize_helper_mode(config: &GatewayConfig) -> &str {
    match config.helper_mode.trim() {
        "browser_fetch" => "browser_fetch",
        "page_context" => "page_context",
        "disabled" => "disabled",
        _ => "probe_only",
    }
}

fn should_launch_browser_bridge(config: &GatewayConfig) -> bool {
    normalize_transport_mode(config) == BRIDGE_TRANSPORT
        || matches!(normalize_helper_mode(config), "browser_fetch" | "page_context")
}

fn alloc_bridge_port() -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).context("failed to reserve browser bridge port")?;
    Ok(listener.local_addr()?.port())
}

fn generate_bridge_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn bridge_health_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/health")
}

fn wait_until_browser_bridge_ready(port: u16, token: &str) -> Result<()> {
    let client = http_client()?;
    for _ in 0..40 {
        if let Ok(response) = client
            .get(bridge_health_url(port))
            .bearer_auth(token)
            .send()
        {
            if response.status().is_success() {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(anyhow!("browser bridge did not become ready in time"))
}

fn spawn_browser_bridge_process(electron: ElectronLaunch, port: u16, token: &str, state_file: &Path) -> Result<Child> {
    let script = browser_bridge_script_path()?;
    let user_data_dir = app_paths::helper_user_data_dir()?;
    let logs_dir = app_paths::logs_dir()?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("gateway-browser-bridge.stdout.log"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("gateway-browser-bridge.stderr.log"))?;

    let mut command = Command::new(electron.binary);
    command
        .env_remove("ELECTRON_RUN_AS_NODE")
        .arg(script)
        .arg("--user-data-dir")
        .arg(user_data_dir)
        .arg("--port")
        .arg(port.to_string())
        .arg("--token")
        .arg(token)
        .arg("--state-file")
        .arg(state_file)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if let Some(override_dist) = electron.override_dist {
        command.env("ELECTRON_OVERRIDE_DIST_PATH", override_dist);
    }

    command.spawn().context("failed to spawn browser bridge")
}

fn stop_child_slot(slot: &Mutex<Option<Child>>) {
    let mut guard = slot.lock().expect("process mutex poisoned");
    if let Some(child) = guard.as_mut() {
        child.kill().ok();
        let _ = child.wait();
    }
    *guard = None;
}

fn stop_browser_bridge(state: &State<'_, SidecarManager>) {
    stop_child_slot(&state.browser_bridge_child);
}

fn launch_browser_bridge(state: &State<'_, SidecarManager>) -> Result<BrowserBridgeLaunch> {
    stop_browser_bridge(state);
    let electron = electron_launch()?;
    let port = alloc_bridge_port()?;
    let token = generate_bridge_token();
    let state_file = app_paths::browser_bridge_state_path()?;
    let child = spawn_browser_bridge_process(electron, port, &token, &state_file)?;
    *state.browser_bridge_child.lock().expect("bridge mutex poisoned") = Some(child);
    wait_until_browser_bridge_ready(port, &token)?;
    Ok(BrowserBridgeLaunch {
        url: format!("http://127.0.0.1:{port}"),
        token,
        state_file,
    })
}

pub fn start_sidecar(state: &State<'_, SidecarManager>, config: &GatewayConfig) -> Result<(bool, Option<u32>)> {
    let (running, pid, _) = state.snapshot();
    if running {
        return Ok((true, pid));
    }

    let bridge = if should_launch_browser_bridge(config) {
        Some(launch_browser_bridge(state)?)
    } else {
        stop_browser_bridge(state);
        None
    };

    let binary = sidecar_binary_path()?;
    let config_path = write_sidecar_config(config)?;
    let runtime_path = app_paths::sidecar_runtime_state_path()?;
    save_runtime_states(&[])?;

    let logs_dir = app_paths::logs_dir()?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("gateway-sidecar.stdout.log"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("gateway-sidecar.stderr.log"))?;

    let mut command = Command::new(binary);
    command
        .arg("--config")
        .arg(config_path)
        .arg("--runtime-state")
        .arg(runtime_path)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    if let Some(bridge) = bridge {
        command
            .env(BRIDGE_ENV_URL, bridge.url)
            .env(BRIDGE_ENV_TOKEN, bridge.token)
            .env(BRIDGE_ENV_STATE_FILE, bridge.state_file);
    } else {
        command
            .env_remove(BRIDGE_ENV_URL)
            .env_remove(BRIDGE_ENV_TOKEN)
            .env_remove(BRIDGE_ENV_STATE_FILE);
    }

    let child = match command.spawn().context("failed to spawn sidecar") {
        Ok(child) => child,
        Err(error) => {
            stop_browser_bridge(state);
            return Err(error);
        }
    };
    let pid = Some(child.id());
    *state.sidecar_child.lock().expect("sidecar mutex poisoned") = Some(child);
    state.clear_last_error();
    Ok((true, pid))
}

pub fn stop_sidecar(state: &State<'_, SidecarManager>) -> Result<()> {
    stop_child_slot(&state.sidecar_child);
    stop_browser_bridge(state);
    Ok(())
}

pub fn fetch_models(config: &GatewayConfig) -> Result<Vec<ModelInfo>> {
    let response = http_client()?.get(models_url(config)).send()?;
    if !response.status().is_success() {
        return Ok(default_models());
    }
    let payload = response.json::<ModelListResponse>()?;
    Ok(payload.data)
}

pub fn fetch_runtime_states(config: &GatewayConfig) -> Result<Vec<ClaudeSessionRuntimeState>> {
    match http_client()?.get(runtime_url(config)).send() {
        Ok(response) if response.status().is_success() => {
            let payload = response.json::<Vec<ClaudeSessionRuntimeState>>()?;
            save_runtime_states(&payload)?;
            Ok(payload)
        }
        _ => load_runtime_states(),
    }
}

pub fn wait_until_ready(config: &GatewayConfig) -> Result<()> {
    let client = http_client()?;
    for _ in 0..20 {
        if let Ok(response) = client.get(health_url(config)).send() {
            if response.status().is_success() {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(anyhow!("sidecar did not become ready in time"))
}
