//! Native macOS window material for the main WebView.
//!
//! The frontend stays transparent and supplies only a light graphite tint. The
//! operating system owns the blur and refraction, which keeps the window in
//! step with the user's wallpaper and other macOS surfaces.

use crate::modules::logger;
use objc2_web_kit::WKWebView;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, WebviewWindow, Window};
use window_vibrancy::{
    apply_liquid_glass, apply_vibrancy, LiquidGlassOptions, NSGlassEffectViewStyle,
    NSVisualEffectMaterial, NSVisualEffectState,
};

const MAIN_WINDOW_LABEL: &str = "main";
const WINDOW_CORNER_RADIUS: f64 = 26.0;

/// macOS creates a separate black Space beneath a true full-screen window.
/// There is no desktop wallpaper in that space for a transparent WebView (or
/// an NSGlassEffectView) to refract. Keep one conversion in flight so the
/// system's green control expands into a desktop-preserving maximized window
/// instead of leaving the product on an opaque black canvas.
static FULLSCREEN_EXIT_PENDING: AtomicBool = AtomicBool::new(false);

/// Applies the modern Liquid Glass material where macOS supports it. On macOS
/// 12 through 25 the same transparent WebView is hosted in a dark HUD vibrancy
/// material, so the application remains legible without presenting a flat
/// opaque window.
pub fn apply_to_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        logger::log_warn("[LiquidGlass] 未找到主窗口，跳过原生材质初始化");
        return;
    };

    match apply_liquid_glass_to_webview(&window) {
        Ok(()) => logger::log_info("[LiquidGlass] 已启用 macOS 原生 Liquid Glass"),
        Err(error) => {
            logger::log_warn(&format!(
                "[LiquidGlass] 原生 Liquid Glass 不可用，改用 macOS 磨砂材质: {}",
                error
            ));
            apply_vibrancy_fallback(&window);
        }
    }
}

/// Converts native macOS full screen into a maximized normal window. This is
/// intentionally scoped to the primary window: utility windows keep their
/// normal platform behavior, while the main surface always preserves the
/// visible desktop that the Liquid Glass design depends on.
pub fn preserve_desktop_backdrop_in_expanded_window(window: &Window) {
    let Ok(is_fullscreen) = window.is_fullscreen() else {
        return;
    };

    if !is_fullscreen {
        FULLSCREEN_EXIT_PENDING.store(false, Ordering::Release);
        return;
    }

    if FULLSCREEN_EXIT_PENDING.swap(true, Ordering::AcqRel) {
        return;
    }

    let window = window.clone();
    std::thread::spawn(move || {
        // Let AppKit finish its full-screen transition before requesting the
        // normal-window geometry, otherwise the request is ignored on Sonoma
        // and later.
        std::thread::sleep(Duration::from_millis(90));

        if matches!(window.is_fullscreen(), Ok(true)) {
            if let Err(error) = window.set_fullscreen(false) {
                logger::log_warn(&format!(
                    "[LiquidGlass] 退出原生全屏以保留桌面背景失败: {}",
                    error
                ));
            } else {
                std::thread::sleep(Duration::from_millis(120));
                if let Err(error) = window.maximize() {
                    logger::log_warn(&format!(
                        "[LiquidGlass] 最大化桌面玻璃窗口失败: {}",
                        error
                    ));
                }
            }
        }

        FULLSCREEN_EXIT_PENDING.store(false, Ordering::Release);
    });
}

fn apply_liquid_glass_to_webview(window: &WebviewWindow) -> Result<(), String> {
    let native_window = window.clone();
    let application_result = Arc::new(Mutex::new(None));
    let application_result_for_webview = Arc::clone(&application_result);

    window
        .with_webview(move |webview| {
            // Tauri owns the WKWebView. Supplying it as the content view makes
            // the native glass view wrap the page instead of being hidden
            // behind it.
            let webview: &WKWebView = unsafe { &*webview.inner().cast() };
            let options = LiquidGlassOptions::new(NSGlassEffectViewStyle::Clear)
                .radius(WINDOW_CORNER_RADIUS)
                .opaque(false)
                .content_view(webview);
            let result = apply_liquid_glass(&native_window, options).map_err(|error| error.to_string());
            *application_result_for_webview
                .lock()
                .expect("Liquid Glass result lock poisoned") = Some(result);
        })
        .map_err(|error| error.to_string())?;

    let result = application_result
        .lock()
        .map_err(|_| "Liquid Glass result lock poisoned".to_string())?
        .take()
        .unwrap_or_else(|| Err("Tauri did not expose the main WKWebView".to_string()));
    result
}

fn apply_vibrancy_fallback(window: &WebviewWindow) {
    if let Err(error) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        Some(WINDOW_CORNER_RADIUS),
    ) {
        logger::log_warn(&format!("[LiquidGlass] macOS 磨砂材质初始化失败: {}", error));
    } else {
        logger::log_info("[LiquidGlass] 已启用 macOS 磨砂降级材质");
    }
}
