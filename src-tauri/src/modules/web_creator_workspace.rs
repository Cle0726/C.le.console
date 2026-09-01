//! Single-window embedded creator workspace.
//!
//! The main C.le. window owns one visible child webview at a time.  Each
//! account still gets its own WebView data directory, so switching accounts
//! does not merge cookies, local storage, or provider sessions.  The child
//! view is deliberately managed here instead of opening a top-level window
//! for every account.

use crate::modules::doubao_web;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, WebviewBuilder},
    AppHandle, Manager, Webview, WebviewUrl, WebviewWindowBuilder,
};
use tokio::io::AsyncWriteExt;
use url::Url;

const CREATOR_WEBVIEW_PREFIX: &str = "cle-creator-account-";
pub const CREATOR_WORKSPACE_WINDOW_LABEL: &str = "web-creator-workspace";
const CREATOR_BRIDGE: &str = include_str!("../../resources/web_creator_bridge.js");
static ACTIVE_ACCOUNT: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static CREATOR_VISIBLE: AtomicBool = AtomicBool::new(false);
static ASSET_RESPONSES: OnceLock<Mutex<HashMap<String, AssetTitleResponse>>> = OnceLock::new();
static WORKSPACE_WINDOW_CREATION: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Default)]
struct AssetTitleResponse {
    expected: usize,
    chunks: Vec<Option<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCreatorBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_true")]
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCreatorWorkspaceState {
    pub active_account_id: Option<String>,
    pub current_url: Option<String>,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCreatorAsset {
    pub id: String,
    pub url: String,
    pub clean_url: String,
    pub kind: String,
    pub source: String,
    pub title: String,
    pub platform: String,
    pub discovered_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCreatorDownloadResult {
    pub path: String,
    pub bytes: u64,
    pub used_clean_url: bool,
}

fn default_true() -> bool {
    true
}

fn active_lock() -> &'static Mutex<Option<String>> {
    ACTIVE_ACCOUNT.get_or_init(|| Mutex::new(None))
}

fn asset_responses() -> &'static Mutex<HashMap<String, AssetTitleResponse>> {
    ASSET_RESPONSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn workspace_window_creation_lock() -> &'static Mutex<()> {
    WORKSPACE_WINDOW_CREATION.get_or_init(|| Mutex::new(()))
}

fn webview_label(account_id: &str) -> String {
    format!("{CREATOR_WEBVIEW_PREFIX}{account_id}")
}

fn creator_webviews(app: &AppHandle) -> Vec<Webview> {
    app.webviews()
        .into_iter()
        .map(|(_, view)| view)
        .filter(|view| view.label().starts_with(CREATOR_WEBVIEW_PREFIX))
        .collect()
}

fn hide_creator_webviews(app: &AppHandle) {
    for view in creator_webviews(app) {
        let _ = view.hide();
    }
}

fn bounds_or_default(bounds: Option<WebCreatorBounds>) -> WebCreatorBounds {
    bounds.unwrap_or(WebCreatorBounds {
        x: 310.0,
        y: 160.0,
        width: 940.0,
        height: 560.0,
        visible: true,
    })
}

/// Build the hidden workbench once during Tauri setup. Creating a top-level
/// WebView from an IPC command can block WebView2 initialization and also race
/// labels reserved by configured windows, so window creation belongs here.
pub fn initialize_workspace_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview(CREATOR_WORKSPACE_WINDOW_LABEL).is_some() {
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|item| item.label == CREATOR_WORKSPACE_WINDOW_LABEL)
        .ok_or_else(|| "网页创作工作台窗口配置不存在".to_string())?;
    let window = WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("读取网页创作工作台窗口配置失败: {error}"))?
        .build()
        .map_err(|error| format!("初始化网页创作工作台失败: {error}"))?;
    window.hide().map_err(|error| error.to_string())?;
    Ok(())
}

/// Open one dedicated creator workbench window. Accounts are still switched
/// inside this single window; this deliberately does not recreate the old
/// one-window-per-account behavior.
pub fn show_workspace_window(app: &AppHandle) -> Result<(), String> {
    // The main page can request the workbench while Tauri is still registering
    // startup webviews. Serialize creation so rapid clicks/effect re-runs can
    // never attempt to build two windows with the same label.
    let _creation_guard = workspace_window_creation_lock()
        .lock()
        .map_err(|_| "网页创作工作台窗口锁异常".to_string())?;
    // The hidden window is initialized once during Tauri setup. Building it
    // again here races WebView2 and caused the intermittent "already exists"
    // error reported by the UI.
    let window = (0..40)
        .find_map(|_| {
            // Config-created windows are registered as a Window plus its
            // managed Webview. On Tauri 2.10 `get_webview_window` can return
            // None for that shape even though the label already exists.
            let window = app
                .get_webview(CREATOR_WORKSPACE_WINDOW_LABEL)
                .map(|webview| webview.window());
            if window.is_none() {
                std::thread::sleep(Duration::from_millis(25));
            }
            window
        })
        .ok_or_else(|| "网页创作工作台仍在初始化，请稍后重试".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_bounds(view: &Webview, bounds: &WebCreatorBounds) -> Result<(), String> {
    view.set_position(tauri::LogicalPosition::new(
        bounds.x.max(0.0),
        bounds.y.max(0.0),
    ))
    .map_err(|error| error.to_string())?;
    view.set_size(tauri::LogicalSize::new(
        bounds.width.max(1.0),
        bounds.height.max(1.0),
    ))
    .map_err(|error| error.to_string())?;
    if bounds.visible {
        view.show().map_err(|error| error.to_string())?;
    } else {
        view.hide().map_err(|error| error.to_string())?;
    }
    CREATOR_VISIBLE.store(bounds.visible, Ordering::Release);
    Ok(())
}

fn capture_asset_title(title: &str) {
    const PREFIX: &str = "__CLE_ASSETS__";
    let Some(payload) = title.strip_prefix(PREFIX) else {
        return;
    };
    let mut parts = payload.splitn(4, ':');
    let (Some(request_id), Some(index), Some(total), Some(chunk)) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return;
    };
    let (Ok(index), Ok(total)) = (index.parse::<usize>(), total.parse::<usize>()) else {
        return;
    };
    if total == 0 || total > 256 || index >= total || request_id.len() > 80 {
        return;
    }
    if let Ok(mut responses) = asset_responses().lock() {
        let Some(response) = responses.get_mut(request_id) else {
            return;
        };
        if response.expected == 0 {
            response.expected = total;
            response.chunks.resize(total, None);
        }
        if response.expected == total {
            response.chunks[index] = Some(chunk.to_string());
        }
    }
}

fn safe_component(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | ' ' | '（' | '）')
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.');
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.chars().take(80).collect()
    }
}

fn creator_download_dir(app: &AppHandle, platform_id: &str) -> Result<PathBuf, String> {
    let root = dirs::download_dir()
        .or_else(|| app.path().app_data_dir().ok())
        .ok_or_else(|| "无法定位下载目录".to_string())?;
    let platform_name = doubao_web::platform(platform_id)
        .map(|item| item.name)
        .unwrap_or("网页创作");
    Ok(root
        .join("C.le网页创作")
        .join(safe_component(platform_name, "网页创作")))
}

fn file_name_from_url(url: &Url, kind: &str) -> String {
    let stem = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .filter(|value| !value.is_empty())
        .unwrap_or(if kind == "video" {
            "creator_video.mp4"
        } else {
            "creator_image.png"
        });
    let mut file_name = safe_component(
        stem,
        if kind == "video" {
            "creator_video.mp4"
        } else {
            "creator_image.png"
        },
    );
    if PathBuf::from(&file_name).extension().is_none() {
        file_name.push_str(if kind == "video" { ".mp4" } else { ".png" });
    }
    file_name
}

fn cookie_header(view: &Webview, url: &Url) -> Option<String> {
    view.cookies_for_url(url.clone()).ok().map(|cookies| {
        cookies
            .iter()
            .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
            .collect::<Vec<_>>()
            .join("; ")
    })
}

async fn cookie_header_async(view: Webview, url: Url) -> Result<Option<String>, String> {
    // WebView2 cookie reads can deadlock the window message loop when they are
    // executed directly from an IPC command future. Keep the dispatcher wait
    // on a dedicated blocking worker, matching Tauri's Windows guidance.
    tokio::task::spawn_blocking(move || cookie_header(&view, &url))
        .await
        .map_err(|error| format!("读取网页 Cookie 任务失败: {error}"))
}

fn active_account_id() -> Option<String> {
    active_lock().lock().ok().and_then(|value| value.clone())
}

fn set_active_account_id(value: Option<String>) {
    if let Ok(mut active) = active_lock().lock() {
        *active = value;
    }
}

fn parse_callback_json<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
    let value: Value = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
    let text = value.as_str().unwrap_or(raw);
    serde_json::from_str(text).map_err(|error| format!("网页素材数据格式错误: {error}"))
}

fn bridge_script(platform_id: &str) -> String {
    let platform_json = serde_json::to_string(platform_id).unwrap_or_else(|_| "\"unknown\"".into());
    let original_upload = if platform_id == "doubao" {
        doubao_web::DOUBAO_ORIGINAL_UPLOAD_SCRIPT
    } else {
        ""
    };
    format!(
        "{original_upload}
window.__CLE_WEB_CREATOR_PLATFORM__ = {platform_json};
{CREATOR_BRIDGE}"
    )
}

async fn create_embedded_view(
    app: AppHandle,
    parent: tauri::Window,
    account: doubao_web::DoubaoWebAccountRecord,
    bounds: WebCreatorBounds,
) -> Result<Webview, String> {
    let platform = doubao_web::platform(&account.platform_id)
        .ok_or_else(|| "不支持的网页创作平台".to_string())?;
    let url = Url::parse(platform.home_url).map_err(|error| error.to_string())?;
    let data_dir = doubao_web::browser_data_dir(&app, &account)?;
    std::fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建网页账号目录: {error}"))?;
    let label = webview_label(&account.id);
    let app_for_new_window = app.clone();
    let label_for_new_window = label.clone();
    let platform_id = account.platform_id.clone();
    let bypass_system_proxy = platform_id == "doubao";
    let download_dir = creator_download_dir(&app, &platform_id)?;
    std::fs::create_dir_all(&download_dir)
        .map_err(|error| format!("创建网页下载目录失败: {error}"))?;
    let view = tokio::task::spawn_blocking(move || {
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
            .data_directory(data_dir)
            // Tauri's native file-drop handler is enabled by default and
            // consumes the Windows OLE drop before WebView2 can turn it into
            // the page's HTML5 DragEvent/DataTransfer. Creator sites such as
            // Doubao therefore see no File when a user drags an image or
            // document into the chat composer. Let WebView2 own file drops for
            // this embedded browser; the surrounding C.le UI does not process
            // dropped files itself.
            .disable_drag_drop_handler()
            .initialization_script(bridge_script(&platform_id))
            .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
            .on_new_window(move |url, _features| {
                if let Some(view) = app_for_new_window.get_webview(&label_for_new_window) {
                    let _ = view.navigate(url);
                }
                NewWindowResponse::Deny
            })
            .on_document_title_changed(|_view, title| capture_asset_title(&title))
            .on_download(move |_view, event| {
                if let DownloadEvent::Requested { destination, .. } = event {
                    if let Some(file_name) = destination.file_name().map(|name| name.to_owned()) {
                        *destination = download_dir.join(safe_component(
                            &file_name.to_string_lossy(),
                            "creator_download",
                        ));
                    }
                }
                true
            });
        if bypass_system_proxy {
            // Doubao's website region-check page is triggered by the user's
            // global proxy egress even though the desktop client works on the
            // local route. Bypass that proxy only inside this account WebView;
            // do not mutate WinINET/WinHTTP/system proxy settings.
            builder = builder.additional_browser_args("--no-proxy-server");
        }
        let view = parent.add_child(
            builder,
            tauri::LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
            tauri::LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )?;
        view.hide()?;
        Ok::<_, tauri::Error>(view)
    })
    .await
    .map_err(|error| format!("创建内嵌网页视图失败: {error}"))?
    .map_err(|error| format!("创建内嵌网页视图失败: {error}"))?;
    Ok(view)
}

pub async fn open_account(
    app: AppHandle,
    account_id: String,
    bounds: Option<WebCreatorBounds>,
) -> Result<WebCreatorWorkspaceState, String> {
    let account = doubao_web::find_account(&app, &account_id)?;
    let account_for_cookie_sync = account.clone();
    let close_app = app.clone();
    let close_account = account.clone();
    let closed_independent = tokio::task::spawn_blocking(move || {
        doubao_web::close_independent_window(&close_app, &close_account)
    })
    .await
    .map_err(|error| format!("关闭账号独立窗口任务失败: {error}"))??;
    if closed_independent {
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let bounds = bounds_or_default(bounds);
    // Config-created windows are registered as a Window plus a managed
    // Webview on Tauri 2.10. `get_webview_window()` can therefore return None
    // even while the dedicated workbench is alive. Resolve its actual Window
    // through the managed Webview; otherwise the account child is mistakenly
    // attached to `main` and floats over/crops the control-center UI.
    let parent = app
        .get_webview(CREATOR_WORKSPACE_WINDOW_LABEL)
        .map(|webview| webview.window())
        .ok_or_else(|| "网页创作工作台尚未就绪".to_string())?;
    let label = webview_label(&account.id);
    for view in creator_webviews(&app) {
        if view.label() != label {
            let _ = view.close();
        }
    }
    let synced_cookie_header = if app.get_webview(&label).is_none() {
        let cached_app = app.clone();
        let cached_account = account_for_cookie_sync.clone();
        tokio::task::spawn_blocking(move || {
            doubao_web::synced_cookie_header(&cached_app, &cached_account)
        })
        .await
        .map_err(|error| format!("读取已同步登录凭证任务失败: {error}"))?
        .unwrap_or(None)
    } else {
        None
    };
    let view = if let Some(view) = app.get_webview(&label) {
        view
    } else {
        create_embedded_view(app.clone(), parent, account, bounds.clone()).await?
    };
    let cookie_sync_app = app.clone();
    let cookie_sync_account = account_for_cookie_sync.clone();
    let cookie_sync_view = view.clone();
    let cookie_sync_result = tokio::task::spawn_blocking(move || {
        let desktop = doubao_web::sync_desktop_cookies_to_view(
            &cookie_sync_app,
            &cookie_sync_account,
            &cookie_sync_view,
        )?;
        let portable = doubao_web::sync_portable_cookies_to_view(
            &cookie_sync_app,
            &cookie_sync_account,
            &cookie_sync_view,
        )?;
        Ok::<_, String>(portable.or(desktop))
    })
    .await
    .map_err(|error| format!("导入豆包 Cookie 任务失败: {error}"))??;
    if cookie_sync_result
        .as_ref()
        .is_some_and(|result| result.refreshed)
    {
        let home_url = doubao_web::platform(&account_for_cookie_sync.platform_id)
            .ok_or_else(|| "不支持的网页创作平台".to_string())?
            .home_url;
        view.navigate(Url::parse(home_url).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Cookie 已导入，但刷新豆包页面失败: {error}"))?;
        tokio::time::sleep(Duration::from_millis(450)).await;
    }
    if let Some(result) = cookie_sync_result {
        if let Some(cookie_header) = result.cookie_header.or(synced_cookie_header) {
            let check = doubao_web::validate_doubao_cookie_header(cookie_header).await;
            doubao_web::update_session_check(&app, &account_id, &check)?;
            doubao_web::finalize_portable_cookie_import(
                &app,
                &account_id,
                check.verified && check.logged_in,
            );
        } else if let Some(warning) = result.warning {
            tracing::warn!("{warning}");
        }
    }
    // Do not read WebView2 cookies while the account view is being created.
    // On Windows that dispatcher call can deadlock the UI message loop before
    // the first navigation completes. Login verification is kept separately
    // from opening/resizing the workbench.
    apply_bounds(&view, &bounds)?;
    set_active_account_id(Some(account_id));
    Ok(workspace_state(&app))
}

pub fn set_bounds(
    app: &AppHandle,
    bounds: WebCreatorBounds,
) -> Result<WebCreatorWorkspaceState, String> {
    if let Some(account_id) = active_account_id() {
        if let Some(view) = app.get_webview(&webview_label(&account_id)) {
            apply_bounds(&view, &bounds)?;
        }
    }
    Ok(workspace_state(app))
}

pub fn hide(app: &AppHandle) -> Result<WebCreatorWorkspaceState, String> {
    hide_creator_webviews(app);
    CREATOR_VISIBLE.store(false, Ordering::Release);
    Ok(workspace_state(app))
}

pub async fn detach_account(
    app: AppHandle,
    account_id: Option<String>,
) -> Result<WebCreatorWorkspaceState, String> {
    let account_id = account_id
        .or_else(active_account_id)
        .ok_or_else(|| "还没有打开网页账号".to_string())?;
    let account = doubao_web::find_account(&app, &account_id)?;
    let view = app
        .get_webview(&webview_label(&account_id))
        .ok_or_else(|| "网页账号视图尚未创建".to_string())?;
    let current_url = view.url().ok().map(|url| url.to_string());
    view.close()
        .map_err(|error| format!("从工作台分离网页失败: {error}"))?;
    set_active_account_id(None);
    CREATOR_VISIBLE.store(false, Ordering::Release);
    tokio::time::sleep(Duration::from_millis(350)).await;

    let open_app = app.clone();
    tokio::task::spawn_blocking(move || {
        doubao_web::open_independent_window(&open_app, &account, current_url)
    })
    .await
    .map_err(|error| format!("创建账号独立窗口任务失败: {error}"))??;
    Ok(workspace_state(&app))
}

pub fn navigate(app: &AppHandle, action: String) -> Result<WebCreatorWorkspaceState, String> {
    let Some(account_id) = active_account_id() else {
        return Ok(workspace_state(app));
    };
    let Some(view) = app.get_webview(&webview_label(&account_id)) else {
        return Ok(workspace_state(app));
    };
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err("不支持的网页导航操作".into()),
    };
    view.eval(script).map_err(|error| error.to_string())?;
    Ok(workspace_state(app))
}

pub fn navigate_to(app: &AppHandle, raw_url: String) -> Result<WebCreatorWorkspaceState, String> {
    let Some(account_id) = active_account_id() else {
        return Err("还没有打开网页账号".into());
    };
    let view = app
        .get_webview(&webview_label(&account_id))
        .ok_or_else(|| "网页账号视图尚未创建".to_string())?;
    let url = Url::parse(raw_url.trim()).map_err(|error| format!("地址无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("仅允许打开 HTTP/HTTPS 地址".into());
    }
    view.navigate(url).map_err(|error| error.to_string())?;
    Ok(workspace_state(app))
}

pub fn workspace_state(app: &AppHandle) -> WebCreatorWorkspaceState {
    let active_account_id = active_account_id();
    let current_url = active_account_id
        .as_deref()
        .and_then(|id| app.get_webview(&webview_label(id)))
        .and_then(|view| view.url().ok())
        .map(|url| url.to_string());
    let visible = CREATOR_VISIBLE.load(Ordering::Acquire)
        && active_account_id
            .as_deref()
            .and_then(|id| app.get_webview(&webview_label(id)))
            .is_some();
    WebCreatorWorkspaceState {
        active_account_id,
        current_url,
        visible,
    }
}

pub async fn collect_assets(
    app: AppHandle,
    account_id: Option<String>,
) -> Result<Vec<WebCreatorAsset>, String> {
    let account_id = account_id
        .or_else(active_account_id)
        .ok_or_else(|| "还没有打开网页账号".to_string())?;
    let view = app
        .get_webview(&webview_label(&account_id))
        .ok_or_else(|| "网页账号视图尚未创建".to_string())?;
    let request_id = uuid::Uuid::new_v4().to_string();
    asset_responses()
        .lock()
        .map_err(|_| "素材响应通道不可用".to_string())?
        .insert(request_id.clone(), AssetTitleResponse::default());
    let request_json = serde_json::to_string(&request_id).map_err(|error| error.to_string())?;
    let script = format!(
        r#"(() => {{
          try {{
            const requestId = {request_json};
            const originalTitle = document.title;
            const raw = encodeURIComponent(JSON.stringify(window.__CLE_WEB_CREATOR_BRIDGE__?.assets?.() || []));
            const chunks = raw.match(/.{{1,3000}}/g) || ['%5B%5D'];
            chunks.forEach((chunk, index) => setTimeout(() => {{
              document.title = `__CLE_ASSETS__${{requestId}}:${{index}}:${{chunks.length}}:${{chunk}}`;
              if (index + 1 === chunks.length) setTimeout(() => {{ document.title = originalTitle; }}, 30);
            }}, index * 20));
          }} catch (_) {{}}
        }})()"#
    );
    if let Err(error) = view.eval(&script) {
        if let Ok(mut responses) = asset_responses().lock() {
            responses.remove(&request_id);
        }
        return Err(error.to_string());
    }
    for _ in 0..240 {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let encoded = {
            let mut responses = asset_responses()
                .lock()
                .map_err(|_| "素材响应通道不可用".to_string())?;
            let complete = responses.get(&request_id).is_some_and(|response| {
                response.expected > 0 && response.chunks.iter().all(Option::is_some)
            });
            complete.then(|| responses.remove(&request_id)).flatten()
        };
        if let Some(response) = encoded {
            let encoded = response.chunks.into_iter().flatten().collect::<String>();
            let raw = urlencoding::decode(&encoded)
                .map_err(|error| format!("解码网页素材失败: {error}"))?;
            return parse_callback_json(&raw);
        }
    }
    if let Ok(mut responses) = asset_responses().lock() {
        responses.remove(&request_id);
    }
    Err("读取网页素材超时，请等待页面加载完成后重试".into())
}

pub async fn download_asset(
    app: AppHandle,
    account_id: Option<String>,
    asset: WebCreatorAsset,
) -> Result<WebCreatorDownloadResult, String> {
    let account_id = account_id
        .or_else(active_account_id)
        .ok_or_else(|| "还没有打开网页账号".to_string())?;
    let account = doubao_web::find_account(&app, &account_id)?;
    let referer = doubao_web::platform(&account.platform_id)
        .map(|platform| platform.home_url)
        .unwrap_or("https://www.doubao.com/");
    let view = app
        .get_webview(&webview_label(&account_id))
        .ok_or_else(|| "网页账号视图尚未创建".to_string())?;
    let clean = Url::parse(&asset.clean_url).ok();
    let original = Url::parse(&asset.url).map_err(|error| format!("素材地址无效: {error}"))?;
    if !matches!(original.scheme(), "http" | "https") {
        return Err("仅支持 HTTP/HTTPS 素材地址".into());
    }
    let download_dir = creator_download_dir(&app, &account.platform_id)?;
    tokio::fs::create_dir_all(&download_dir)
        .await
        .map_err(|error| format!("创建下载目录失败: {error}"))?;
    let base_name = file_name_from_url(clean.as_ref().unwrap_or(&original), &asset.kind);
    let mut target = download_dir.join(base_name);
    let mut index = 2;
    while target.exists() {
        let stem = target
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("creator");
        let ext = target
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{s}"))
            .unwrap_or_default();
        target = download_dir.join(format!("{stem}_{index}{ext}"));
        index += 1;
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("C.le.网页创作中心/1.1")
        .build()
        .map_err(|error| format!("创建下载客户端失败: {error}"))?;
    let cookie = cookie_header_async(
        view.clone(),
        clean.clone().unwrap_or_else(|| original.clone()),
    )
    .await?;
    let mut candidates = clean
        .into_iter()
        .chain(std::iter::once(original))
        .collect::<Vec<_>>();
    candidates.dedup_by(|left, right| left.as_str() == right.as_str());
    let mut last_error = String::new();
    for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        let mut request = client
            .get(candidate.clone())
            .header(reqwest::header::REFERER, referer);
        if let Some(cookie) = &cookie {
            request = request.header(reqwest::header::COOKIE, cookie);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let mut file = tokio::fs::File::create(&target)
                    .await
                    .map_err(|error| format!("创建下载文件失败: {error}"))?;
                let mut bytes = 0u64;
                let mut response = response;
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|error| format!("读取素材失败: {error}"))?
                {
                    file.write_all(&chunk)
                        .await
                        .map_err(|error| format!("写入素材失败: {error}"))?;
                    bytes += chunk.len() as u64;
                }
                file.flush()
                    .await
                    .map_err(|error| format!("完成素材写入失败: {error}"))?;
                return Ok(WebCreatorDownloadResult {
                    path: target.to_string_lossy().into_owned(),
                    bytes,
                    used_clean_url: candidate_index == 0 && asset.clean_url != asset.url,
                });
            }
            Ok(response) => last_error = format!("HTTP {}", response.status()),
            Err(error) => last_error = error.to_string(),
        }
    }
    Err(format!("下载素材失败: {last_error}"))
}

pub fn clear_assets(app: &AppHandle, account_id: Option<String>) -> Result<(), String> {
    let account_id = account_id
        .or_else(active_account_id)
        .ok_or_else(|| "还没有打开网页账号".to_string())?;
    let view = app
        .get_webview(&webview_label(&account_id))
        .ok_or_else(|| "网页账号视图尚未创建".to_string())?;
    view.eval("window.__CLE_WEB_CREATOR_BRIDGE__?.clear?.()")
        .map_err(|error| error.to_string())
}

pub async fn clear_account_browsing_data(
    app: &AppHandle,
    account_id: &str,
    home_url: &str,
) -> Result<bool, String> {
    let Some(view) = app.get_webview(&webview_label(account_id)) else {
        return Ok(false);
    };
    let url = Url::parse(home_url).map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        view.clear_all_browsing_data()
            .map_err(|error| format!("清理网页登录数据失败: {error}"))?;
        view.navigate(url).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("清理网页登录数据任务失败: {error}"))??;
    Ok(true)
}

pub async fn inspect_account_session(
    app: &AppHandle,
    account_id: &str,
    home_url: &str,
) -> Result<Option<(Option<String>, bool, bool, Option<String>)>, String> {
    let Some(view) = app.get_webview(&webview_label(account_id)) else {
        return Ok(None);
    };
    let current_url = view.url().ok().map(|url| url.to_string());
    let cookie_url = Url::parse(home_url).map_err(|error| error.to_string())?;
    let is_doubao = cookie_url
        .host_str()
        .is_some_and(|host| host == "doubao.com" || host.ends_with(".doubao.com"));
    if is_doubao {
        // Reading cookies from a newly created WebView2 can deadlock its window
        // thread. The authoritative server result is cached by doubao_web and
        // opening the workbench must stay independent from network validation.
        let check = doubao_web::cached_doubao_session_check(app, account_id)?;
        return Ok(Some((
            current_url,
            check.logged_in,
            check.verified,
            check.detail,
        )));
    }
    let cookies = tokio::task::spawn_blocking(move || view.cookies_for_url(cookie_url))
        .await
        .map_err(|error| format!("网页登录状态检查任务失败: {error}"))?
        .map_err(|error| format!("无法读取网页登录状态: {error}"))?;
    let logged_in = cookies.iter().any(|cookie| {
        let name = cookie.name().to_ascii_lowercase();
        !cookie.value().trim().is_empty()
            && (name.contains("session")
                || name.contains("token")
                || name.contains("auth")
                || name.contains("login"))
    });
    Ok(Some((current_url, logged_in, true, None)))
}

pub fn close_account_view(app: &AppHandle, account_id: &str) -> Result<(), String> {
    if let Some(view) = app.get_webview(&webview_label(account_id)) {
        view.close().map_err(|error| error.to_string())?;
    }
    if active_account_id().as_deref() == Some(account_id) {
        set_active_account_id(None);
        CREATOR_VISIBLE.store(false, Ordering::Release);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_download_names_without_path_escape() {
        assert_eq!(
            safe_component("..\\secret/name.mp4", "fallback"),
            "secretname.mp4"
        );
        assert_eq!(safe_component("  ", "fallback"), "fallback");
    }

    #[test]
    fn parses_callback_json_string() {
        let value: Vec<WebCreatorAsset> = parse_callback_json("\"[]\"").unwrap();
        assert!(value.is_empty());
    }

    #[test]
    fn enables_doubao_original_upload_branch_only_for_doubao() {
        let doubao = bridge_script("doubao");
        assert!(doubao.contains("webkitConvertPointFromNodeToPage"));
        assert!(doubao.contains("30 * 1024 * 1024"));
        assert!(doubao.contains("__CLE_DOUBAO_ORIGINAL_UPLOAD__"));

        let jimeng = bridge_script("jimeng");
        assert!(!jimeng.contains("webkitConvertPointFromNodeToPage"));
        assert!(!jimeng.contains("__CLE_DOUBAO_ORIGINAL_UPLOAD__"));
    }
}
