//! Doubao web login and video generation bridge.
//!
//! The request shape and Samantha SSE flow are adapted from the Apache-2.0
//! project https://github.com/wangchuxiaoji-oss/doubao2api. C.le. deliberately
//! runs the request in its dedicated Tauri webview so the user's real Doubao
//! page session and the site's own request-signing hooks remain authoritative.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const DEFAULT_ACCOUNT_ID: &str = "default";
const GENERATION_TIMEOUT: Duration = Duration::from_secs(390);
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static GENERATING_ACCOUNTS: OnceLock<tokio::sync::Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoubaoWebAccountRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default = "default_platform_id")]
    pub(crate) platform_id: String,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    #[serde(default)]
    last_known_logged_in: bool,
    #[serde(default)]
    last_error: String,
    #[serde(default)]
    consecutive_failures: u32,
    #[serde(default)]
    last_used_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DoubaoWebAccountStore {
    #[serde(default)]
    accounts: Vec<DoubaoWebAccountRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoWebAccountState {
    pub id: String,
    pub name: String,
    pub platform_id: String,
    pub enabled: bool,
    pub busy: bool,
    pub window_open: bool,
    pub logged_in: bool,
    pub status_verified: bool,
    pub current_url: Option<String>,
    pub message: String,
    pub last_error: Option<String>,
    pub consecutive_failures: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoWebState {
    pub platforms: Vec<WebCreatorPlatform>,
    pub accounts: Vec<DoubaoWebAccountState>,
    pub selected_account_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebCreatorPlatform {
    pub id: &'static str,
    pub name: &'static str,
    pub short_name: &'static str,
    pub description: &'static str,
    pub home_url: &'static str,
    pub capabilities: &'static [&'static str],
}

const WEB_CREATOR_PLATFORMS: &[WebCreatorPlatform] = &[
    WebCreatorPlatform {
        id: "doubao",
        name: "豆包",
        short_name: "DB",
        description: "对话、图片与 Seedance 视频创作",
        home_url: "https://www.doubao.com/chat/",
        capabilities: &["多账号", "图片", "视频", "结果下载"],
    },
    WebCreatorPlatform {
        id: "jimeng",
        name: "即梦",
        short_name: "JM",
        description: "图片、视频与画布创作",
        home_url: "https://jimeng.jianying.com/ai-tool/generate",
        capabilities: &["多账号", "图片", "视频", "API"],
    },
    WebCreatorPlatform {
        id: "qianwen",
        name: "通义千问",
        short_name: "QW",
        description: "千问网页创作与媒体结果管理",
        home_url: "https://tongyi.aliyun.com/",
        capabilities: &["多账号", "图片", "视频"],
    },
    WebCreatorPlatform {
        id: "xiaoyunque",
        name: "小云雀",
        short_name: "XYQ",
        description: "剪映小云雀视频创作",
        home_url: "https://xyq.jianying.com/",
        capabilities: &["多账号", "视频", "结果下载"],
    },
    WebCreatorPlatform {
        id: "douyin",
        name: "抖音",
        short_name: "DY",
        description: "抖音网页浏览与作品管理",
        home_url: "https://www.douyin.com/",
        capabilities: &["多账号", "作品浏览", "结果下载"],
    },
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoWebVideoRequest {
    #[serde(default)]
    pub account_id: Option<String>,
    pub prompt: String,
    #[serde(default = "default_ratio")]
    pub ratio: String,
}

fn default_ratio() -> String {
    "16:9".into()
}

fn default_true() -> bool {
    true
}

fn default_platform_id() -> String {
    "doubao".into()
}

pub(crate) fn platform(id: &str) -> Option<&'static WebCreatorPlatform> {
    WEB_CREATOR_PLATFORMS
        .iter()
        .find(|platform| platform.id == id)
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("无法定位网页创作浏览器数据目录: {error}"))
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("doubao-web-accounts.json"))
}

fn default_account() -> DoubaoWebAccountRecord {
    DoubaoWebAccountRecord {
        id: DEFAULT_ACCOUNT_ID.into(),
        name: "豆包账号 1".into(),
        platform_id: default_platform_id(),
        enabled: true,
        last_known_logged_in: false,
        last_error: String::new(),
        consecutive_failures: 0,
        last_used_at: 0,
    }
}

fn valid_account_id(value: &str) -> bool {
    value == DEFAULT_ACCOUNT_ID
        || (!value.is_empty()
            && value.len() <= 64
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric()))
}

fn valid_platform_id(value: &str) -> bool {
    platform(value).is_some()
}

fn read_store_unlocked(app: &AppHandle) -> Result<DoubaoWebAccountStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        let store = DoubaoWebAccountStore {
            accounts: vec![default_account()],
        };
        write_store_unlocked(app, &store)?;
        return Ok(store);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| format!("无法读取网页创作账号配置: {error}"))?;
    let mut store: DoubaoWebAccountStore =
        serde_json::from_str(&raw).map_err(|error| format!("网页创作账号配置格式损坏: {error}"))?;
    let mut ids = HashSet::new();
    for account in &store.accounts {
        if !valid_account_id(&account.id)
            || !valid_platform_id(&account.platform_id)
            || !ids.insert(account.id.as_str())
        {
            return Err("网页创作账号配置包含无效或重复的账号 ID".into());
        }
    }
    if store.accounts.is_empty() {
        store.accounts.push(default_account());
        write_store_unlocked(app, &store)?;
    }
    Ok(store)
}

fn write_store_unlocked(app: &AppHandle, store: &DoubaoWebAccountStore) -> Result<(), String> {
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建网页创作账号配置目录: {error}"))?;
    }
    let raw = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("无法序列化网页创作账号配置: {error}"))?;
    std::fs::write(path, raw).map_err(|error| format!("无法保存网页创作账号配置: {error}"))
}

fn load_store(app: &AppHandle) -> Result<DoubaoWebAccountStore, String> {
    let _guard = STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "网页创作账号配置锁已损坏".to_string())?;
    read_store_unlocked(app)
}

fn update_store<R>(
    app: &AppHandle,
    update: impl FnOnce(&mut DoubaoWebAccountStore) -> Result<R, String>,
) -> Result<R, String> {
    let _guard = STORE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "网页创作账号配置锁已损坏".to_string())?;
    let mut store = read_store_unlocked(app)?;
    let result = update(&mut store)?;
    write_store_unlocked(app, &store)?;
    Ok(result)
}

pub(crate) fn find_account(
    app: &AppHandle,
    account_id: &str,
) -> Result<DoubaoWebAccountRecord, String> {
    load_store(app)?
        .accounts
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "网页创作账号不存在，请刷新账号列表".to_string())
}

fn normalized_name(value: &str, fallback: &str) -> String {
    let value = value.trim();
    let value = if value.is_empty() { fallback } else { value };
    value.chars().take(40).collect()
}

fn account_window_label(account: &DoubaoWebAccountRecord) -> String {
    if account.id == DEFAULT_ACCOUNT_ID && account.platform_id == "doubao" {
        "doubao-web-login".into()
    } else {
        format!("web-creator-{}-{}", account.platform_id, account.id)
    }
}

pub(crate) fn browser_data_dir(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
) -> Result<PathBuf, String> {
    if !valid_account_id(&account.id) || !valid_platform_id(&account.platform_id) {
        return Err("网页创作账号 ID 无效".into());
    }
    if account.id == DEFAULT_ACCOUNT_ID && account.platform_id == "doubao" {
        // Reuse the original single-account profile so existing users stay logged in.
        Ok(app_data_dir(app)?.join("doubao-web-profile"))
    } else {
        Ok(app_data_dir(app)?
            .join("web-creator-profiles")
            .join(&account.platform_id)
            .join(&account.id))
    }
}

fn ensure_window(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let window_label = account_window_label(account);
    if let Some(window) = app.get_webview_window(&window_label) {
        if visible {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        return Ok(window);
    }

    let data_dir = browser_data_dir(app, account)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建网页创作浏览器数据目录: {error}"))?;
    let platform =
        platform(&account.platform_id).ok_or_else(|| "不支持的网页创作平台".to_string())?;
    let url = Url::parse(platform.home_url).map_err(|error| error.to_string())?;
    let window = WebviewWindowBuilder::new(app, &window_label, WebviewUrl::External(url))
        .title(format!("{}网页版 · {}", platform.name, account.name))
        .inner_size(1180.0, 820.0)
        .min_inner_size(880.0, 640.0)
        .resizable(true)
        .visible(visible)
        .data_directory(data_dir)
        .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
        .build()
        .map_err(|error| format!("无法打开{}网页版: {error}", platform.name))?;

    if visible {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(window)
}

async fn inspect_account(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
) -> Result<DoubaoWebAccountState, String> {
    let busy = GENERATING_ACCOUNTS
        .get_or_init(|| tokio::sync::Mutex::new(HashSet::new()))
        .lock()
        .await
        .contains(&account.id);
    let platform =
        platform(&account.platform_id).ok_or_else(|| "不支持的网页创作平台".to_string())?;
    if let Some((current_url, logged_in)) =
        crate::modules::web_creator_workspace::inspect_account_session(
            app,
            &account.id,
            platform.home_url,
        )
        .await?
    {
        return Ok(DoubaoWebAccountState {
            id: account.id.clone(),
            name: account.name.clone(),
            platform_id: account.platform_id.clone(),
            enabled: account.enabled,
            busy,
            window_open: true,
            logged_in,
            status_verified: true,
            current_url,
            message: if !account.enabled {
                "已停用，不参与自动故障切换".into()
            } else if busy {
                "正在生成视频".into()
            } else if logged_in {
                format!("{}网页登录状态可用", platform.name)
            } else {
                format!("请在当前工作台中完成{}登录或扫码确认", platform.name)
            },
            last_error: (!account.last_error.is_empty()).then(|| account.last_error.clone()),
            consecutive_failures: account.consecutive_failures,
        });
    }
    let window_label = account_window_label(account);
    let Some(window) = app.get_webview_window(&window_label) else {
        return Ok(DoubaoWebAccountState {
            id: account.id.clone(),
            name: account.name.clone(),
            platform_id: account.platform_id.clone(),
            enabled: account.enabled,
            busy,
            window_open: false,
            logged_in: account.last_known_logged_in,
            status_verified: false,
            current_url: None,
            message: if !account.enabled {
                "已停用，不参与自动故障切换".into()
            } else if busy {
                "正在生成视频".into()
            } else if account.last_known_logged_in {
                "上次检测已登录，生成前会再次验证".into()
            } else {
                "尚未检测到网页登录状态".into()
            },
            last_error: (!account.last_error.is_empty()).then(|| account.last_error.clone()),
            consecutive_failures: account.consecutive_failures,
        });
    };
    let current_url = window.url().ok().map(|url| url.to_string());
    let cookie_url = Url::parse(platform.home_url).map_err(|error| error.to_string())?;
    let cookies = tokio::task::spawn_blocking(move || window.cookies_for_url(cookie_url))
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

    Ok(DoubaoWebAccountState {
        id: account.id.clone(),
        name: account.name.clone(),
        platform_id: account.platform_id.clone(),
        enabled: account.enabled,
        busy,
        window_open: true,
        logged_in,
        status_verified: true,
        current_url,
        message: if !account.enabled {
            "已停用，不参与自动故障切换".into()
        } else if busy {
            "正在生成视频".into()
        } else if logged_in {
            format!("{}网页登录状态可用", platform.name)
        } else {
            format!("请在专用窗口中完成{}登录或扫码确认", platform.name)
        },
        last_error: (!account.last_error.is_empty()).then(|| account.last_error.clone()),
        consecutive_failures: account.consecutive_failures,
    })
}

fn update_last_known_login(
    app: &AppHandle,
    account_id: &str,
    logged_in: bool,
) -> Result<(), String> {
    update_store(app, |store| {
        if let Some(account) = store
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
        {
            account.last_known_logged_in = logged_in;
        }
        Ok(())
    })
}

async fn build_state(
    app: &AppHandle,
    selected_account_id: Option<String>,
) -> Result<DoubaoWebState, String> {
    let store = load_store(app)?;
    let mut accounts = Vec::with_capacity(store.accounts.len());
    for account in &store.accounts {
        let state = inspect_account(app, account).await?;
        if state.status_verified && state.logged_in != account.last_known_logged_in {
            update_last_known_login(app, &account.id, state.logged_in)?;
        }
        accounts.push(state);
    }
    let selected_account_id =
        selected_account_id.filter(|id| accounts.iter().any(|account| account.id == *id));
    let logged_in_count = accounts.iter().filter(|account| account.logged_in).count();
    let enabled_count = accounts.iter().filter(|account| account.enabled).count();
    Ok(DoubaoWebState {
        platforms: WEB_CREATOR_PLATFORMS.to_vec(),
        message: format!(
            "共 {} 个网页创作账号，{} 个启用，{} 个已检测登录",
            accounts.len(),
            enabled_count,
            logged_in_count
        ),
        accounts,
        selected_account_id,
    })
}

pub async fn get_state(
    app: AppHandle,
    selected_account_id: Option<String>,
) -> Result<DoubaoWebState, String> {
    build_state(&app, selected_account_id).await
}

pub async fn add_account(
    app: AppHandle,
    platform_id: Option<String>,
    name: Option<String>,
) -> Result<DoubaoWebState, String> {
    let platform_id = platform_id.unwrap_or_else(default_platform_id);
    let platform = platform(&platform_id).ok_or_else(|| "不支持的网页创作平台".to_string())?;
    let account = update_store(&app, |store| {
        if store.accounts.len() >= 50 {
            return Err("网页创作账号最多可添加 50 个".into());
        }
        let account_count = store.accounts.len() + 1;
        let account = DoubaoWebAccountRecord {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: normalized_name(
                name.as_deref().unwrap_or(""),
                &format!("{}账号 {account_count}", platform.name),
            ),
            platform_id: platform_id.clone(),
            enabled: true,
            last_known_logged_in: false,
            last_error: String::new(),
            consecutive_failures: 0,
            last_used_at: 0,
        };
        store.accounts.push(account.clone());
        Ok(account)
    })?;
    // The unified creator center opens the account inside the main window.
    // Do not create a top-level browser window as a side effect of adding it.
    build_state(&app, Some(account.id)).await
}

pub async fn rename_account(
    app: AppHandle,
    account_id: String,
    name: String,
) -> Result<DoubaoWebState, String> {
    let name = normalized_name(&name, "网页账号");
    update_store(&app, |store| {
        let account = store
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or_else(|| "网页创作账号不存在，请刷新账号列表".to_string())?;
        account.name = name.clone();
        Ok(())
    })?;
    let renamed = find_account(&app, &account_id)?;
    if let Some(window) = app.get_webview_window(&account_window_label(&renamed)) {
        let platform_name = platform(&renamed.platform_id).map_or("网页创作", |item| item.name);
        let _ = window.set_title(&format!("{platform_name}网页版 · {name}"));
    }
    build_state(&app, Some(account_id)).await
}

pub async fn set_account_enabled(
    app: AppHandle,
    account_id: String,
    enabled: bool,
) -> Result<DoubaoWebState, String> {
    if !enabled {
        ensure_account_idle(&account_id).await?;
    }
    update_store(&app, |store| {
        let account = store
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
            .ok_or_else(|| "网页创作账号不存在，请刷新账号列表".to_string())?;
        account.enabled = enabled;
        Ok(())
    })?;
    build_state(&app, Some(account_id)).await
}

pub async fn remove_account(app: AppHandle, account_id: String) -> Result<DoubaoWebState, String> {
    ensure_account_idle(&account_id).await?;
    let removed = update_store(&app, |store| {
        let index = store
            .accounts
            .iter()
            .position(|account| account.id == account_id)
            .ok_or_else(|| "网页创作账号不存在，请刷新账号列表".to_string())?;
        let removed = store.accounts.remove(index);
        if store.accounts.is_empty() {
            store.accounts.push(default_account());
        }
        Ok(removed)
    })?;
    if let Some(window) = app.get_webview_window(&account_window_label(&removed)) {
        let _ = window.close();
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let _ = crate::modules::web_creator_workspace::close_account_view(&app, &removed.id);
    let profile_dir = browser_data_dir(&app, &removed)?;
    if profile_dir.exists() {
        let _ = std::fs::remove_dir_all(profile_dir);
    }
    build_state(&app, None).await
}

pub async fn open_login(app: AppHandle, account_id: String) -> Result<DoubaoWebState, String> {
    let account = find_account(&app, &account_id)?;
    ensure_window(&app, &account, true)?;
    tokio::time::sleep(Duration::from_millis(600)).await;
    build_state(&app, Some(account_id)).await
}

pub async fn logout(app: AppHandle, account_id: String) -> Result<DoubaoWebState, String> {
    ensure_account_idle(&account_id).await?;
    let account = find_account(&app, &account_id)?;
    let home_url = platform(&account.platform_id)
        .ok_or_else(|| "不支持的网页创作平台".to_string())?
        .home_url;
    if !crate::modules::web_creator_workspace::clear_account_browsing_data(
        &app,
        &account_id,
        home_url,
    )? {
        // Compatibility cleanup for accounts that were last opened by an older
        // release in a top-level window. New unified-workspace accounts never
        // create that extra window.
        if let Some(window) = app.get_webview_window(&account_window_label(&account)) {
            window
                .clear_all_browsing_data()
                .map_err(|error| format!("清理网页登录状态失败: {error}"))?;
            let _ = window.navigate(Url::parse(home_url).map_err(|error| error.to_string())?);
        } else {
            let profile_dir = browser_data_dir(&app, &account)?;
            if profile_dir.exists() {
                std::fs::remove_dir_all(&profile_dir)
                    .map_err(|error| format!("清理网页登录数据失败: {error}"))?;
            }
        }
    }
    update_last_known_login(&app, &account_id, false)?;
    build_state(&app, Some(account_id)).await
}

async fn wait_until_page_ready(window: &WebviewWindow) -> Result<(), String> {
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(25) {
            return Err("豆包网页版加载超时，请打开登录窗口后刷新页面".into());
        }
        if let Ok(url) = window.url() {
            if url
                .host_str()
                .is_some_and(|host| host.ends_with("doubao.com"))
            {
                // Let the site's request-signing hooks finish installing.
                tokio::time::sleep(Duration::from_secs(2)).await;
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}

pub async fn generate_video(
    app: AppHandle,
    request: DoubaoWebVideoRequest,
) -> Result<Value, String> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("请填写视频提示词".into());
    }
    if !matches!(request.ratio.as_str(), "1:1" | "16:9" | "9:16") {
        return Err("豆包网页版当前仅支持 1:1、16:9、9:16".into());
    }

    let explicit_account_id = request.account_id.filter(|value| !value.trim().is_empty());
    let mut candidates = generation_candidates(&app, explicit_account_id.as_deref())?;
    let explicit = explicit_account_id.is_some();
    let mut attempt_errors = Vec::new();
    let mut busy_accounts = 0usize;

    for account in candidates.drain(..) {
        if !try_reserve_account(&account.id).await {
            busy_accounts += 1;
            continue;
        }
        let result =
            generate_video_inner(app.clone(), &account, &prompt, &request.ratio, explicit).await;
        release_account(&account.id).await;

        match result {
            Ok(mut value) => {
                record_account_success(&app, &account.id)?;
                if let Some(object) = value.as_object_mut() {
                    object.insert("accountId".into(), Value::String(account.id.clone()));
                    object.insert("accountName".into(), Value::String(account.name.clone()));
                    if !attempt_errors.is_empty() {
                        object.insert(
                            "accountRetry".into(),
                            serde_json::json!({
                                "attempts": attempt_errors.len() + 1,
                                "failedAccounts": attempt_errors,
                            }),
                        );
                    }
                }
                return Ok(value);
            }
            Err(error) => {
                record_account_failure(&app, &account.id, &error)?;
                let retry = !explicit && is_retryable_video_error(&error);
                attempt_errors.push(format!("{}: {}", account.name, truncate_error(&error)));
                if !retry {
                    return Err(error);
                }
            }
        }
    }

    if attempt_errors.is_empty() && busy_accounts > 0 {
        return Err("可用的豆包账号当前都在生成视频，请等待已有任务完成".into());
    }
    if attempt_errors.is_empty() {
        return Err("没有启用且可用的豆包网页账号，请先在网页创作中心添加账号".into());
    }
    Err(format!("豆包账号池尝试失败：{}", attempt_errors.join("；")))
}

fn generation_candidates(
    app: &AppHandle,
    explicit_account_id: Option<&str>,
) -> Result<Vec<DoubaoWebAccountRecord>, String> {
    if let Some(account_id) = explicit_account_id {
        let account = find_account(app, account_id)?;
        if account.platform_id != "doubao" {
            return Err("所选账号不是豆包网页账号".into());
        }
        if !account.enabled {
            return Err("所选豆包账号已停用".into());
        }
        return Ok(vec![account]);
    }

    let mut accounts: Vec<_> = load_store(app)?
        .accounts
        .into_iter()
        .filter(|account| account.platform_id == "doubao" && account.enabled)
        .collect();
    accounts.sort_by_key(|account| {
        (
            !account.last_known_logged_in,
            account.consecutive_failures,
            account.last_used_at,
        )
    });
    Ok(accounts)
}

async fn try_reserve_account(account_id: &str) -> bool {
    GENERATING_ACCOUNTS
        .get_or_init(|| tokio::sync::Mutex::new(HashSet::new()))
        .lock()
        .await
        .insert(account_id.to_string())
}

async fn release_account(account_id: &str) {
    GENERATING_ACCOUNTS
        .get_or_init(|| tokio::sync::Mutex::new(HashSet::new()))
        .lock()
        .await
        .remove(account_id);
}

fn record_account_success(app: &AppHandle, account_id: &str) -> Result<(), String> {
    update_store(app, |store| {
        if let Some(account) = store.accounts.iter_mut().find(|item| item.id == account_id) {
            account.last_error.clear();
            account.consecutive_failures = 0;
            account.last_used_at = unix_timestamp();
            account.last_known_logged_in = true;
        }
        Ok(())
    })
}

fn record_account_failure(app: &AppHandle, account_id: &str, error: &str) -> Result<(), String> {
    update_store(app, |store| {
        if let Some(account) = store.accounts.iter_mut().find(|item| item.id == account_id) {
            account.last_error = truncate_error(error);
            account.consecutive_failures = account.consecutive_failures.saturating_add(1);
            account.last_used_at = unix_timestamp();
            if is_account_state_error(error) {
                account.last_known_logged_in = false;
            }
        }
        Ok(())
    })
}

fn truncate_error(error: &str) -> String {
    error.chars().take(220).collect()
}

fn is_account_state_error(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    [
        "未登录",
        "登录态",
        "login",
        "session",
        "cookie",
        "unauthorized",
        "forbidden",
        "captcha",
        "验证码",
        "risk",
        "风控",
        "401",
        "403",
        "page crashed",
        "context closed",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

fn is_retryable_video_error(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    is_account_state_error(error)
        || [
            "quota",
            "credit",
            "额度",
            "积分不足",
            "次数已用完",
            "timeout",
            "超时",
            "network",
            "fetch",
            "http 5",
            "服务过载",
            "繁忙",
            "temporarily",
            "豆包没有返回视频任务 id",
        ]
        .iter()
        .any(|marker| text.contains(marker))
}

async fn ensure_account_idle(account_id: &str) -> Result<(), String> {
    if GENERATING_ACCOUNTS
        .get_or_init(|| tokio::sync::Mutex::new(HashSet::new()))
        .lock()
        .await
        .contains(account_id)
    {
        Err("该豆包账号正在生成视频，完成前不能退出或删除".into())
    } else {
        Ok(())
    }
}

async fn generate_video_inner(
    app: AppHandle,
    account: &DoubaoWebAccountRecord,
    prompt: &str,
    ratio: &str,
    show_login_on_auth_error: bool,
) -> Result<Value, String> {
    let window = ensure_window(&app, account, false)?;
    wait_until_page_ready(&window).await?;
    let state = inspect_account(&app, &account).await?;
    update_last_known_login(&app, &account.id, state.logged_in)?;
    if !state.logged_in {
        if show_login_on_auth_error {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return Err("豆包网页版尚未登录，请先点击“登录豆包网页版”并完成登录".into());
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let script = VIDEO_SCRIPT_TEMPLATE
        .replace(
            "__TASK_ID_JSON__",
            &serde_json::to_string(&task_id).unwrap_or_default(),
        )
        .replace(
            "__PROMPT_JSON__",
            &serde_json::to_string(prompt).unwrap_or_default(),
        )
        .replace(
            "__RATIO_JSON__",
            &serde_json::to_string(ratio).unwrap_or_default(),
        );
    window
        .eval(script)
        .map_err(|error| format!("无法提交豆包视频生成任务: {error}"))?;

    let started = Instant::now();
    loop {
        if started.elapsed() > GENERATION_TIMEOUT {
            return Err(
                "豆包视频生成等待超时；任务可能仍在网页版后台处理中，请勿立即重复提交".into(),
            );
        }
        if let Ok(url) = window.url() {
            if let Some(value) = task_state_from_url(&url, &task_id) {
                match value.get("status").and_then(Value::as_str) {
                    Some("success") => {
                        let result = value
                            .get("result")
                            .cloned()
                            .ok_or_else(|| "豆包视频任务完成但没有返回结果".to_string())?;
                        return Ok(result);
                    }
                    Some("error") => {
                        return Err(value
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("豆包视频生成失败")
                            .to_string());
                    }
                    _ => {}
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn task_state_from_url(url: &Url, task_id: &str) -> Option<Value> {
    let encoded = url.fragment()?.strip_prefix("cle-doubao-task=")?;
    let decoded = urlencoding::decode(encoded).ok()?;
    let value: Value = serde_json::from_str(&decoded).ok()?;
    (value.get("taskId").and_then(Value::as_str) == Some(task_id)).then_some(value)
}

const VIDEO_SCRIPT_TEMPLATE: &str = r#"
(() => {
  const taskKey = __TASK_ID_JSON__;
  const prompt = __PROMPT_JSON__;
  const ratio = __RATIO_JSON__;
  window.__CLE_DOUBAO_VIDEO_TASKS = window.__CLE_DOUBAO_VIDEO_TASKS || {};
  const publish = (state) => {
    const next = { taskId: taskKey, ...state };
    window.__CLE_DOUBAO_VIDEO_TASKS[taskKey] = next;
    history.replaceState(history.state, '', location.pathname + location.search + '#cle-doubao-task=' + encodeURIComponent(JSON.stringify(next)));
  };
  publish({ status: 'running', phase: 'submit' });

  const parseJson = (value, fallback = {}) => {
    if (typeof value !== 'string') return value || fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  };
  const parseSse = (raw) => raw.split(/\r?\n\r?\n/).flatMap((block) => {
    const line = block.split(/\r?\n/).find((item) => item.startsWith('data:'));
    if (!line) return [];
    try { return [JSON.parse(line.slice(5).trim())]; } catch (_) { return []; }
  });
  const cookieValue = (name) => {
    const item = document.cookie.split(';').map((value) => value.trim())
      .find((value) => value.startsWith(name + '='));
    return item ? item.slice(name.length + 1) : '';
  };
  const localJson = (key) => {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) { return {}; }
  };
  const queryString = (includeFingerprint = true) => {
    const samantha = localJson('samantha_web_web_id');
    const tea = localJson('__tea_cache_tokens_497858');
    const deviceId = samantha.web_id || '';
    const webId = tea.web_id || '';
    const params = new URLSearchParams({
      aid: '497858', device_id: deviceId, device_platform: 'web',
      language: 'zh', pc_version: '3.19.4',
      pkg_type: 'release_version', real_aid: '497858', region: '',
      samantha_web: '1', sys_region: '', tea_uuid: webId,
      'use-olympus-account': '1', version_code: '20800', web_id: webId,
      web_tab_id: crypto.randomUUID(),
    });
    const msToken = cookieValue('msToken');
    if (msToken) params.set('msToken', msToken);
    if (includeFingerprint) {
      const fingerprint = cookieValue('s_v_web_id');
      if (fingerprint) params.set('fp', fingerprint);
    }
    return params.toString();
  };
  const request = async (path, payload, timeoutMs, includeFingerprint = true) => {
    const csrf = cookieValue('passport_csrf_token');
    const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'agw-js-conv': 'str' };
    if (csrf) headers['x-tt-passport-csrf-token'] = csrf;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path + '?' + queryString(includeFingerprint), {
        method: 'POST', headers, body: JSON.stringify(payload),
        credentials: 'include', signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
      if (body.trim().startsWith('{')) {
        const parsed = parseJson(body, null);
        if (parsed && parsed.code) throw new Error(`${parsed.code}: ${parsed.msg || parsed.message || '登录态或请求校验失败'}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
  const videoItems = (raw) => {
    const videos = [];
    for (const event of parseSse(raw)) {
      if (event.event_type === 2005) throw new Error(String(event.event_data || '豆包返回生成错误'));
      if (event.event_type !== 2001) continue;
      const eventData = parseJson(event.event_data, event.event_data || {});
      const message = parseJson(eventData.message, eventData.message || {});
      if (message.content_type !== 2021) continue;
      const content = parseJson(message.content, message.content || {});
      const items = Array.isArray(content.data) ? content.data : [content];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        let videoUrl = item.video_url || item.url || '';
        if (!videoUrl && item.video_model) {
          const model = parseJson(item.video_model, {});
          const list = model.video_list || {};
          for (const value of Object.values(list)) {
            if (value && value.main_url) {
              try { videoUrl = atob(value.main_url); } catch (_) {}
              if (videoUrl) break;
            }
          }
        }
        const cover = item.cover || {};
        if (videoUrl) videos.push({
          url: videoUrl,
          video_url: videoUrl,
          cover_url: item.cover_url || cover.url || '',
          width: item.width || 0,
          height: item.height || 0,
          duration: item.duration || 0,
        });
      }
    }
    return videos;
  };

  (async () => {
    try {
      const content = { text: prompt, ratio };
      const message = {
        content: JSON.stringify(content), content_type: 2020,
        attachments: [], references: [],
        skill: { skill_type: 17, skill_type_no_default: 17, skill_id: '17', skill_id_no_default: '17' },
      };
      const payload = {
        messages: [message],
        completion_option: {
          is_regen: false, with_suggest: true, need_create_conversation: true,
          launch_stage: 1, is_replace: false, is_delete: false,
          is_ai_playground: false, memory_type: 2, message_from: 0,
          use_deep_think: false, use_auto_cot: false, resend_for_regen: false,
          enable_commerce_credit: false, action_bar_skill_id: 17,
        },
        evaluate_option: { web_ab_params: '' },
        local_conversation_id: crypto.randomUUID(),
        local_message_id: crypto.randomUUID(),
      };
      const submitRaw = await request('/samantha/chat/completion', payload, 60000, true);
      const directVideos = videoItems(submitRaw);
      if (directVideos.length) {
        publish({
          status: 'success', result: { created: Math.floor(Date.now() / 1000), data: directVideos, provider: 'doubao-web', model: 'doubao-web-seedance-2.0' },
        });
        return;
      }
      let asyncTaskId = '';
      let responseText = '';
      for (const event of parseSse(submitRaw)) {
        if (event.event_type === 2005) throw new Error(String(event.event_data || '豆包返回生成错误'));
        if (event.event_type !== 2001) continue;
        const eventData = parseJson(event.event_data, event.event_data || {});
        const fin = eventData.fin_reason || {};
        if (fin.reason === 1 && fin.async_task) asyncTaskId = fin.async_task.id || '';
        const message = parseJson(eventData.message, eventData.message || {});
        if (message.content_type === 2001) responseText += parseJson(message.content, {}).text || '';
      }
      if (!asyncTaskId) throw new Error(responseText || '豆包没有返回视频任务 ID');
      publish({ status: 'running', phase: 'render', upstreamTaskId: asyncTaskId });
      const resultRaw = await request('/samantha/chat/async/stream', { task_id: asyncTaskId, event_id: 0 }, 320000, false);
      const videos = videoItems(resultRaw);
      if (!videos.length) throw new Error('豆包任务结束但没有返回可用的视频地址');
      publish({
        status: 'success',
        result: { created: Math.floor(Date.now() / 1000), data: videos, provider: 'doubao-web', model: 'doubao-web-seedance-2.0' },
      });
    } catch (error) {
      publish({ status: 'error', error: String(error && error.message ? error.message : error) });
    }
  })();
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_task_state_from_url_fragment() {
        let url = Url::parse(
            "https://www.doubao.com/chat/#cle-doubao-task=%7B%22taskId%22%3A%22one%22%2C%22status%22%3A%22success%22%7D",
        )
        .unwrap();
        let value = task_state_from_url(&url, "one").unwrap();
        assert_eq!(value["status"], "success");
    }

    #[test]
    fn video_script_substitution_does_not_leave_placeholders() {
        let script = VIDEO_SCRIPT_TEMPLATE
            .replace("__TASK_ID_JSON__", "\"task\"")
            .replace("__PROMPT_JSON__", "\"cat\"")
            .replace("__RATIO_JSON__", "\"16:9\"");
        assert!(!script.contains("__TASK_ID_JSON__"));
        assert!(script.contains("content_type: 2020"));
        assert!(script.contains("content_type !== 2021"));
        assert!(script.contains("/samantha/chat/async/stream"));
        assert!(script.contains("event_id: 0 }, 320000, false"));
    }

    #[test]
    fn account_ids_cannot_escape_profile_directory() {
        assert!(valid_account_id(DEFAULT_ACCOUNT_ID));
        assert!(valid_account_id("0123456789abcdef"));
        assert!(!valid_account_id("../other-profile"));
        assert!(!valid_account_id("account-with-dash"));
        assert!(!valid_account_id(""));
    }

    #[test]
    fn account_names_are_trimmed_and_bounded() {
        assert_eq!(normalized_name("  主账号  ", "备用"), "主账号");
        assert_eq!(normalized_name("   ", "备用"), "备用");
        assert_eq!(
            normalized_name(&"号".repeat(50), "备用").chars().count(),
            40
        );
    }

    #[test]
    fn supports_all_web_creator_platforms() {
        for id in ["doubao", "jimeng", "qianwen", "xiaoyunque", "douyin"] {
            assert!(valid_platform_id(id), "missing platform {id}");
        }
        assert!(!valid_platform_id("unknown"));
    }

    #[test]
    fn legacy_doubao_accounts_migrate_without_data_loss() {
        let account: DoubaoWebAccountRecord = serde_json::from_str(
            r#"{"id":"default","name":"原豆包账号","lastKnownLoggedIn":true}"#,
        )
        .unwrap();
        assert_eq!(account.platform_id, "doubao");
        assert!(account.enabled);
        assert_eq!(account.name, "原豆包账号");
        assert!(account.last_known_logged_in);
    }

    #[test]
    fn retry_classifier_separates_account_errors_from_prompt_errors() {
        assert!(is_retryable_video_error("session expired: HTTP 401"));
        assert!(is_retryable_video_error("视频额度已用完"));
        assert!(is_retryable_video_error("service timeout"));
        assert!(!is_retryable_video_error("提示词包含敏感内容"));
    }
}
