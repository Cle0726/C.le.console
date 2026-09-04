use tauri::{AppHandle, Manager, WebviewWindowBuilder};

pub const MULTI_MODEL_API_WINDOW_LABEL: &str = "multi-model-api-console";

/// Create the independent API console once during application setup. Keeping a
/// stable window label avoids duplicate WebView2 instances when the entry is
/// clicked repeatedly.
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    if app.get_webview(MULTI_MODEL_API_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|item| item.label == MULTI_MODEL_API_WINDOW_LABEL)
        .ok_or_else(|| "多模型 API 独立窗口配置不存在".to_string())?;
    let window = WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("读取多模型 API 窗口配置失败: {error}"))?
        .build()
        .map_err(|error| format!("初始化多模型 API 独立窗口失败: {error}"))?;
    window.hide().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    // Setup normally creates the hidden window up front. Re-create lazily as a
    // defensive path for macOS restores and for a click racing setup.
    if app.get_webview(MULTI_MODEL_API_WINDOW_LABEL).is_none() {
        initialize(app)?;
    }
    let window = app
        .get_webview(MULTI_MODEL_API_WINDOW_LABEL)
        .map(|webview| webview.window())
        .ok_or_else(|| "多模型 API 独立窗口创建失败".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app
        .get_webview(MULTI_MODEL_API_WINDOW_LABEL)
        .map(|webview| webview.window())
    {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview(MULTI_MODEL_API_WINDOW_LABEL)
        .map(|webview| webview.window())
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}
