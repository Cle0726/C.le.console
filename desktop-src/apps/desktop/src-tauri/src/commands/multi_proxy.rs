use tauri::State;

use crate::multi_proxy::{
    self, MultiProxyImageTestResult, MultiProxyManager, MultiProxyStatus, MultiProxyTestResult,
};

#[tauri::command]
pub fn get_multi_proxy_status(manager: State<'_, MultiProxyManager>) -> Result<MultiProxyStatus, String> {
    Ok(multi_proxy::build_status(&manager))
}

#[tauri::command]
pub fn start_multi_proxy(manager: State<'_, MultiProxyManager>) -> Result<MultiProxyStatus, String> {
    multi_proxy::start(&manager).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stop_multi_proxy(manager: State<'_, MultiProxyManager>) -> Result<MultiProxyStatus, String> {
    multi_proxy::stop(&manager).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_multi_proxy_snapshot(admin_token: String) -> Result<serde_json::Value, String> {
    multi_proxy::read_snapshot(&admin_token).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_multi_proxy_config(admin_token: String, config: serde_json::Value) -> Result<serde_json::Value, String> {
    multi_proxy::save_config(&admin_token, config).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn reload_multi_proxy(admin_token: String) -> Result<serde_json::Value, String> {
    multi_proxy::reload(&admin_token).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn reset_multi_proxy_runtime(admin_token: String) -> Result<serde_json::Value, String> {
    multi_proxy::reset_runtime(&admin_token).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn test_multi_proxy_chat(model: Option<String>, message: String) -> Result<MultiProxyTestResult, String> {
    multi_proxy::test_chat(model, message).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn test_multi_proxy_image(
    api_mode: Option<String>,
    model: Option<String>,
    prompt: String,
    size: Option<String>,
    quality: Option<String>,
    background: Option<String>,
    n: Option<u32>,
) -> Result<MultiProxyImageTestResult, String> {
    multi_proxy::test_image_generation(api_mode, model, prompt, size, quality, background, n)
        .map_err(|error| error.to_string())
}
