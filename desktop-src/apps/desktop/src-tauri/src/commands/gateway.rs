use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    commands::config::{
        build_gateway_status, default_models, load_auth_status, load_gateway_config, load_runtime_states,
        save_gateway_config_inner, GatewaySnapshot, GatewayStatus, ModelInfo,
    },
    sidecar::{fetch_models, fetch_runtime_states, start_sidecar, stop_sidecar, wait_until_ready, SidecarManager},
};


#[derive(Debug, Deserialize)]
struct LocalChatMessage {
    #[allow(dead_code)]
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct LocalChatChoice {
    message: Option<LocalChatMessage>,
}

#[derive(Debug, Deserialize)]
struct LocalChatResponse {
    choices: Option<Vec<LocalChatChoice>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestGatewayChatResult {
    pub ok: bool,
    pub status: u16,
    pub api_url: String,
    pub model: String,
    pub request_message: String,
    pub response_text: Option<String>,
    pub raw_body: String,
}

#[tauri::command]
pub fn get_gateway_snapshot(sidecar: State<'_, SidecarManager>) -> Result<GatewaySnapshot, String> {
    let config = load_gateway_config().map_err(|error| error.to_string())?;
    let (running, pid, last_error) = sidecar.snapshot();
    let runtime_states = if running {
        fetch_runtime_states(&config).unwrap_or_else(|_| load_runtime_states().unwrap_or_default())
    } else {
        load_runtime_states().unwrap_or_default()
    };
    let models = if running {
        fetch_models(&config).unwrap_or_else(|_| default_models())
    } else {
        default_models()
    };

    Ok(GatewaySnapshot {
        status: build_gateway_status(&config, running, pid, last_error),
        config,
        runtime_states,
        auth_status: load_auth_status().unwrap_or(None),
        models,
    })
}

#[tauri::command]
pub fn start_gateway(sidecar: State<'_, SidecarManager>) -> Result<GatewayStatus, String> {
    let mut config = load_gateway_config().map_err(|error| error.to_string())?;
    config.enabled = true;
    let config = save_gateway_config_inner(&config).map_err(|error| error.to_string())?;
    let (_running, pid) = start_sidecar(&sidecar, &config).map_err(|error| error.to_string())?;
    wait_until_ready(&config).map_err(|error| error.to_string())?;
    let (running, _existing_pid, last_error) = sidecar.snapshot();
    Ok(build_gateway_status(&config, running, pid, last_error))
}

#[tauri::command]
pub fn stop_gateway(sidecar: State<'_, SidecarManager>) -> Result<GatewayStatus, String> {
    let mut config = load_gateway_config().map_err(|error| error.to_string())?;
    config.enabled = false;
    let config = save_gateway_config_inner(&config).map_err(|error| error.to_string())?;
    stop_sidecar(&sidecar).map_err(|error| error.to_string())?;
    Ok(build_gateway_status(&config, false, None, None))
}

#[tauri::command]
pub fn list_gateway_models(sidecar: State<'_, SidecarManager>) -> Result<Vec<ModelInfo>, String> {
    let config = load_gateway_config().map_err(|error| error.to_string())?;
    let (running, _, _) = sidecar.snapshot();
    if !running {
        return Ok(default_models());
    }
    fetch_models(&config).map_err(|error| error.to_string())
}


#[tauri::command]
pub fn test_gateway_chat(
    message: String,
    model: Option<String>,
) -> Result<TestGatewayChatResult, String> {
    let config = load_gateway_config().map_err(|error| error.to_string())?;
    let model = model
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "claude-sonnet-5".into());
    let message = if message.trim().is_empty() {
        "你好".to_string()
    } else {
        message.trim().to_string()
    };
    let api_url = format!(
        "http://{}:{}/v1/chat/completions",
        config.listen_host, config.listen_port
    );
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| error.to_string())?;
    let payload = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": message}],
        "stream": false
    });
    let mut request = client.post(&api_url).json(&payload);
    if config.require_api_key {
        if let Some(api_key) = config.local_api_key.as_ref().filter(|value| !value.trim().is_empty()) {
            request = request.bearer_auth(api_key.trim());
        }
    }
    let response = request.send().map_err(|error| {
        format!("本地 API 代理服务未响应：{error}. 请先启动 API 代理服务。")
    })?;
    let status = response.status().as_u16();
    let raw_body = response.text().map_err(|error| error.to_string())?;
    let response_text = serde_json::from_str::<LocalChatResponse>(&raw_body)
        .ok()
        .and_then(|payload| payload.choices)
        .and_then(|mut choices| choices.drain(..).next())
        .and_then(|choice| choice.message)
        .map(|message| message.content);
    Ok(TestGatewayChatResult {
        ok: (200..300).contains(&status),
        status,
        api_url,
        model,
        request_message: message,
        response_text,
        raw_body,
    })
}
