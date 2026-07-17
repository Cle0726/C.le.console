use std::{
    fs::OpenOptions,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::auth_helper::repo_root;

#[derive(Default)]
pub struct MultiProxyManager {
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiProxyStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub api_base_url: String,
    pub ui_url: String,
    pub health: Option<serde_json::Value>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiProxyTestResult {
    pub ok: bool,
    pub status: u16,
    pub raw_body: String,
    pub response_text: Option<String>,
    pub gateway: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiProxyImagePreview {
    pub url: Option<String>,
    pub b64_json: Option<String>,
    pub data_url: Option<String>,
    pub revised_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiProxyImageTestResult {
    pub ok: bool,
    pub status: u16,
    pub api_mode: String,
    pub images: Vec<MultiProxyImagePreview>,
    pub gateway: Option<serde_json::Value>,
    pub debug_body_preview: String,
}

impl MultiProxyManager {
    fn set_last_error(&self, message: impl Into<String>) {
        *self.last_error.lock().expect("multi proxy error mutex poisoned") = Some(message.into());
    }

    fn clear_last_error(&self) {
        *self.last_error.lock().expect("multi proxy error mutex poisoned") = None;
    }

    pub fn snapshot(&self) -> (bool, Option<u32>, Option<String>) {
        let mut running = false;
        let mut pid = None;
        {
            let mut guard = self.child.lock().expect("multi proxy mutex poisoned");
            if let Some(child) = guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        self.set_last_error(format!("multi proxy exited: {status}"));
                        *guard = None;
                    }
                    Ok(None) => {
                        running = true;
                        pid = Some(child.id());
                    }
                    Err(error) => {
                        self.set_last_error(format!("failed to poll multi proxy: {error}"));
                        *guard = None;
                    }
                }
            }
        }
        let last_error = self
            .last_error
            .lock()
            .expect("multi proxy error mutex poisoned")
            .clone();
        (running, pid, last_error)
    }
}

fn service_dir() -> PathBuf {
    repo_root().join("multi-platform-proxy-api")
}

fn config_path() -> PathBuf {
    service_dir().join("config.json")
}

fn node_binary() -> String {
    if cfg!(windows) {
        "node.exe".into()
    } else {
        "node".into()
    }
}

fn logs_dir() -> Result<PathBuf> {
    let dir = service_dir().join("logs");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn http_client() -> Result<Client> {
    Ok(Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()?)
}

pub fn api_origin() -> String {
    "http://127.0.0.1:13978".into()
}

pub fn api_base_url() -> String {
    format!("{}/v1", api_origin())
}

pub fn ui_url() -> String {
    format!("{}/", api_origin())
}

fn health_url() -> String {
    format!("{}/healthz", api_origin())
}

pub fn fetch_health() -> Option<serde_json::Value> {
    http_client()
        .ok()?
        .get(health_url())
        .send()
        .ok()?
        .json::<serde_json::Value>()
        .ok()
}

pub fn build_status(manager: &MultiProxyManager) -> MultiProxyStatus {
    let (running, pid, last_error) = manager.snapshot();
    MultiProxyStatus {
        running,
        pid,
        api_base_url: api_base_url(),
        ui_url: ui_url(),
        health: fetch_health(),
        last_error,
    }
}

pub fn start(manager: &MultiProxyManager) -> Result<MultiProxyStatus> {
    let (running, _, _) = manager.snapshot();
    if running {
        return Ok(build_status(manager));
    }

    let dir = service_dir();
    if !dir.join("src").join("server.js").exists() {
        return Err(anyhow!("multi proxy server not found: {}", dir.display()));
    }
    if !config_path().exists() && dir.join("config.example.json").exists() {
        std::fs::copy(dir.join("config.example.json"), config_path())?;
    }

    let logs = logs_dir()?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("multi-proxy.stdout.log"))?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("multi-proxy.stderr.log"))?;

    let child = Command::new(node_binary())
        .current_dir(&dir)
        .arg("src/server.js")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .with_context(|| format!("failed to spawn multi proxy from {}", dir.display()))?;

    *manager.child.lock().expect("multi proxy mutex poisoned") = Some(child);
    manager.clear_last_error();
    if let Err(error) = wait_until_ready() {
        let message = format!("failed to start multi proxy: {error}");
        let mut guard = manager.child.lock().expect("multi proxy mutex poisoned");
        if let Some(child) = guard.as_mut() {
            child.kill().ok();
            let _ = child.wait();
        }
        *guard = None;
        drop(guard);
        manager.set_last_error(message.clone());
        return Err(anyhow!(message));
    }
    Ok(build_status(manager))
}

pub fn stop(manager: &MultiProxyManager) -> Result<MultiProxyStatus> {
    let mut guard = manager.child.lock().expect("multi proxy mutex poisoned");
    if let Some(child) = guard.as_mut() {
        child.kill().ok();
        let _ = child.wait();
    }
    *guard = None;
    drop(guard);
    Ok(build_status(manager))
}

pub fn wait_until_ready() -> Result<()> {
    let client = http_client()?;
    for _ in 0..30 {
        if let Ok(response) = client.get(health_url()).send() {
            if response.status().is_success() {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(anyhow!("multi proxy did not become ready in time"))
}

pub fn read_snapshot(admin_token: &str) -> Result<serde_json::Value> {
    let payload = http_client()?
        .get(format!("{}/admin/snapshot", api_origin()))
        .bearer_auth(admin_token)
        .send()?
        .error_for_status()?
        .json::<serde_json::Value>()?;
    Ok(payload)
}

pub fn save_config(admin_token: &str, config: serde_json::Value) -> Result<serde_json::Value> {
    let payload = http_client()?
        .post(format!("{}/admin/config", api_origin()))
        .bearer_auth(admin_token)
        .json(&config)
        .send()?
        .error_for_status()?
        .json::<serde_json::Value>()?;
    Ok(payload)
}

pub fn reload(admin_token: &str) -> Result<serde_json::Value> {
    let payload = http_client()?
        .post(format!("{}/admin/reload", api_origin()))
        .bearer_auth(admin_token)
        .json(&serde_json::json!({}))
        .send()?
        .error_for_status()?
        .json::<serde_json::Value>()?;
    Ok(payload)
}

pub fn reset_runtime(admin_token: &str) -> Result<serde_json::Value> {
    let payload = http_client()?
        .post(format!("{}/admin/runtime/reset", api_origin()))
        .bearer_auth(admin_token)
        .json(&serde_json::json!({}))
        .send()?
        .error_for_status()?
        .json::<serde_json::Value>()?;
    Ok(payload)
}

pub fn test_chat(model: Option<String>, message: String) -> Result<MultiProxyTestResult> {
    let model = model.unwrap_or_else(|| "coding-auto".into());
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": if message.trim().is_empty() { "你好，验证多平台反代" } else { message.trim() }}],
        "stream": false
    });
    let response = http_client()?
        .post(format!("{}/v1/chat/completions", api_origin()))
        .json(&body)
        .send()?;
    let status = response.status().as_u16();
    let raw_body = response.text()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw_body).ok();
    let response_text = parsed
        .as_ref()
        .and_then(|value| value.pointer("/choices/0/message/content"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let gateway = parsed
        .as_ref()
        .and_then(|value| value.get("_gateway"))
        .cloned();
    Ok(MultiProxyTestResult {
        ok: (200..300).contains(&status),
        status,
        raw_body,
        response_text,
        gateway,
    })
}

pub fn test_image_generation(
    api_mode: Option<String>,
    model: Option<String>,
    prompt: String,
    size: Option<String>,
    quality: Option<String>,
    background: Option<String>,
    n: Option<u32>,
) -> Result<MultiProxyImageTestResult> {
    let api_mode = normalize_image_api_mode(api_mode.as_deref()).to_string();
    let model = model.unwrap_or_else(|| "image-auto".into());
    let prompt = if prompt.trim().is_empty() {
        "一只蓝眼睛小猫，柔和工作室光照，插画风格".to_string()
    } else {
        prompt.trim().to_string()
    };
    let body = build_image_request_body(
        &api_mode,
        &model,
        &prompt,
        size.as_deref(),
        quality.as_deref(),
        background.as_deref(),
        n,
    );
    let endpoint = if api_mode == "responses" {
        format!("{}/v1/responses", api_origin())
    } else {
        format!("{}/v1/images/generations", api_origin())
    };
    let response = http_client()?.post(endpoint).json(&body).send()?;
    let status = response.status().as_u16();
    let raw_body = response.text()?;
    let parsed = serde_json::from_str::<Value>(&raw_body).ok();
    let gateway = parsed
        .as_ref()
        .and_then(|value| value.get("_gateway"))
        .cloned();
    let images = if api_mode == "responses" {
        parsed
            .as_ref()
            .map(extract_images_from_responses_payload)
            .unwrap_or_default()
    } else {
        parsed
            .as_ref()
            .map(extract_images_from_images_payload)
            .unwrap_or_default()
    };
    Ok(MultiProxyImageTestResult {
        ok: (200..300).contains(&status),
        status,
        api_mode,
        images,
        gateway,
        debug_body_preview: truncate_preview(&raw_body, 1200),
    })
}

fn normalize_image_api_mode(value: Option<&str>) -> &'static str {
    match value.unwrap_or("images").trim().to_ascii_lowercase().as_str() {
        "responses" => "responses",
        _ => "images",
    }
}

fn build_image_request_body(
    api_mode: &str,
    model: &str,
    prompt: &str,
    size: Option<&str>,
    quality: Option<&str>,
    background: Option<&str>,
    n: Option<u32>,
) -> Value {
    if api_mode == "responses" {
        let mut tool = json!({ "type": "image_generation" });
        if let Some(size) = non_empty(size) {
            tool["size"] = Value::String(size.to_string());
        }
        if let Some(quality) = non_empty(quality) {
            tool["quality"] = Value::String(quality.to_string());
        }
        if let Some(background) = non_empty(background) {
            tool["background"] = Value::String(background.to_string());
        }
        json!({
            "model": model,
            "input": prompt,
            "stream": false,
            "tools": [tool],
        })
    } else {
        let mut body = json!({
            "model": model,
            "prompt": prompt,
            "response_format": "b64_json",
            "n": n.unwrap_or(1),
        });
        if let Some(size) = non_empty(size) {
            body["size"] = Value::String(size.to_string());
        }
        if let Some(quality) = non_empty(quality) {
            body["quality"] = Value::String(quality.to_string());
        }
        if let Some(background) = non_empty(background) {
            body["background"] = Value::String(background.to_string());
        }
        body
    }
}

fn extract_images_from_images_payload(value: &Value) -> Vec<MultiProxyImagePreview> {
    value
        .get("data")
        .and_then(|data| data.as_array())
        .map(|items| items.iter().filter_map(extract_image_preview).collect::<Vec<_>>())
        .unwrap_or_default()
}

fn extract_images_from_responses_payload(value: &Value) -> Vec<MultiProxyImagePreview> {
    let mut images = value
        .get("output")
        .and_then(|output| output.as_array())
        .map(|items| items.iter().filter_map(extract_image_preview).collect::<Vec<_>>())
        .unwrap_or_default();
    if images.is_empty() {
        images = extract_images_from_images_payload(value);
    }
    images
}

fn extract_image_preview(value: &Value) -> Option<MultiProxyImagePreview> {
    let direct_url = string_field(value, "url")
        .or_else(|| {
            value
                .get("image_url")
                .and_then(|image| image.get("url"))
                .and_then(|url| url.as_str())
                .map(ToString::to_string)
        })
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("url"))
                .and_then(|url| url.as_str())
                .map(ToString::to_string)
        });
    let direct_b64 = string_field(value, "b64_json")
        .or_else(|| string_field(value, "image_base64"))
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| result.get("b64_json"))
                .and_then(|b64| b64.as_str())
                .map(ToString::to_string)
        });
    let result_string = value
        .get("result")
        .and_then(|result| result.as_str())
        .map(ToString::to_string);
    let url = direct_url.or_else(|| {
        result_string
            .as_deref()
            .filter(|candidate| looks_like_url(candidate))
            .map(ToString::to_string)
    });
    let b64_json = direct_b64.or_else(|| {
        result_string
            .as_deref()
            .filter(|candidate| !looks_like_url(candidate))
            .map(ToString::to_string)
    });
    let revised_prompt = string_field(value, "revised_prompt").or_else(|| string_field(value, "revisedPrompt"));
    let data_url = build_data_url(url.as_deref(), b64_json.as_deref());
    if url.is_none() && b64_json.is_none() && data_url.is_none() {
        return None;
    }
    Some(MultiProxyImagePreview {
        url,
        b64_json,
        data_url,
        revised_prompt,
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .map(ToString::to_string)
}

fn build_data_url(url: Option<&str>, b64_json: Option<&str>) -> Option<String> {
    if let Some(url) = url.filter(|value| value.starts_with("data:image/")) {
        return Some(url.to_string());
    }
    b64_json.map(|data| format!("data:image/png;base64,{data}"))
}

fn looks_like_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://") || value.starts_with("data:image/")
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn truncate_preview(value: &str, max_chars: usize) -> String {
    let truncated: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        format!("{}…", truncated)
    } else {
        truncated
    }
}
