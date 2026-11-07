use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};
use url::Url;

use crate::modules::floating_card_window::{
    FLOATING_CARD_WINDOW_LABEL, INSTANCE_FLOATING_CARD_WINDOW_LABEL_PREFIX,
};
use crate::modules::logger;
use crate::modules::multi_model_api_window::MULTI_MODEL_API_WINDOW_LABEL;
use crate::modules::status_window::STATUS_WINDOW_LABEL;
use crate::modules::web_creator_workspace::CREATOR_WORKSPACE_WINDOW_LABEL;

static PARKED_URLS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn parked_urls() -> std::sync::MutexGuard<'static, Option<HashMap<String, String>>> {
    PARKED_URLS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_ui_shell(label: &str) -> bool {
    label == "main"
        || label == STATUS_WINDOW_LABEL
        || label == FLOATING_CARD_WINDOW_LABEL
        || label == MULTI_MODEL_API_WINDOW_LABEL
        || label == CREATOR_WORKSPACE_WINDOW_LABEL
        || label.starts_with(INSTANCE_FLOATING_CARD_WINDOW_LABEL_PREFIX)
}

fn is_blank(url: &Url) -> bool {
    url.as_str() == "about:blank" || url.scheme() == "about"
}

fn navigate_label<R: Runtime>(app: &AppHandle<R>, label: &str, url: &Url) -> Result<(), String> {
    if let Some(webview) = app.get_webview(label) {
        return webview.navigate(url.clone()).map_err(|error| error.to_string());
    }
    if let Some(window) = app.get_webview_window(label) {
        return window.navigate(url.clone()).map_err(|error| error.to_string());
    }
    Err(format!("{label} 不存在"))
}

/// Drop a hidden window's document so its JavaScript heap and GPU surfaces can
/// be released. The window object and the API processes stay alive.
fn park_webview<R: Runtime>(app: &AppHandle<R>, label: &str, current: &Url) -> bool {
    if is_blank(current) {
        return false;
    }
    parked_urls()
        .get_or_insert_with(HashMap::new)
        .insert(label.to_string(), current.to_string());
    let Ok(blank) = Url::parse("about:blank") else {
        return false;
    };
    if let Err(error) = navigate_label(app, label, &blank) {
        logger::log_warn(&format!("[Window] 卸载 {label} 界面失败: {error}"));
        return false;
    }
    true
}

pub fn restore_parked_label<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(saved) = parked_urls().as_mut().and_then(|urls| urls.remove(label)) else {
        return;
    };
    let Ok(url) = Url::parse(&saved) else {
        logger::log_warn(&format!("[Window] 无法恢复 {label} 的界面地址"));
        return;
    };
    if let Err(error) = navigate_label(app, label, &url) {
        parked_urls()
            .get_or_insert_with(HashMap::new)
            .insert(label.to_string(), saved);
        logger::log_warn(&format!("[Window] 恢复 {label} 界面失败: {error}"));
    }
}

/// Release every hidden console window. Sidecars and in-process API servers
/// are not windows, so they keep serving.
pub fn release_hidden_ui<R: Runtime>(app: &AppHandle<R>) {
    let mut parked = 0usize;
    let mut any_visible = false;
    let webviews = app.webviews();
    for webview in webviews.values() {
        let label = webview.label();
        if !is_ui_shell(label) {
            continue;
        }
        if webview.window().is_visible().unwrap_or(true) {
            any_visible = true;
            continue;
        }
        let Ok(current) = webview.url() else {
            continue;
        };
        if park_webview(app, label, &current) {
            parked += 1;
        }
    }
    if parked == 0 {
        return;
    }
    logger::log_info(&format!(
        "[Window] 已卸载 {parked} 个隐藏界面以释放内存，后台 API 继续运行"
    ));
    if any_visible {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(500));
        crate::modules::webkit_cache_maintenance::checkpoint_webkit_localstorage();
    });
}

#[cfg(test)]
mod tests {
    use super::is_ui_shell;

    #[test]
    fn ui_shells_are_the_console_windows_only() {
        assert!(is_ui_shell("main"));
        assert!(is_ui_shell("status-window"));
        assert!(is_ui_shell("instance-floating-card-1"));
        assert!(!is_ui_shell("doubao-web-session"));
    }
}
