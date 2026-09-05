#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{window::Color, AppHandle, Manager, WebviewWindowBuilder};

pub const MULTI_MODEL_API_WINDOW_LABEL: &str = "multi-model-api-console";

#[cfg(target_os = "macos")]
static NATIVE_MATERIAL_APPLIED: AtomicBool = AtomicBool::new(false);

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
    let builder = WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("读取多模型 API 窗口配置失败: {error}"))?;
    // Wry only disables WKWebView's opaque backing when transparency is set
    // while the WebView is created. The native glass layer alone cannot undo
    // that backing later.
    #[cfg(target_os = "macos")]
    let builder = builder
        .transparent(true)
        // `from_config` also carries the old opaque #0B0C0E fallback into
        // Tao. On macOS that colour wins over `transparent(true)` and leaves a
        // solid black NSWindow beneath an otherwise transparent WKWebView.
        .background_color(Color(0, 0, 0, 0));
    let window = builder
        .build()
        .map_err(|error| format!("初始化多模型 API 独立窗口失败: {error}"))?;
    #[cfg(target_os = "macos")]
    window
        .set_background_color(Some(Color(0, 0, 0, 0)))
        .map_err(|error| format!("清除多模型 API 窗口原生底色失败: {error}"))?;
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

    // NSGlassEffectView needs the final, visible AppKit geometry. Applying it
    // while this eagerly-created utility window is still hidden can leave the
    // transparent WebView above an unmaterialized black backing view.
    #[cfg(target_os = "macos")]
    if !NATIVE_MATERIAL_APPLIED.swap(true, Ordering::AcqRel) {
        if let Some(webview_window) = app.get_webview_window(MULTI_MODEL_API_WINDOW_LABEL) {
            crate::native_liquid_glass::apply_to_webview_window(
                &webview_window,
                "多模型 API 窗口",
            );
        }
    }

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
