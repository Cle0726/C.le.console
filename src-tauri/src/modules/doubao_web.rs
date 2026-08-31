//! Doubao web login and video generation bridge.
//!
//! The request shape and Samantha SSE flow are adapted from the Apache-2.0
//! project https://github.com/wangchuxiaoji-oss/doubao2api. C.le. deliberately
//! runs the request in its dedicated Tauri webview so the user's real Doubao
//! page session and the site's own request-signing hooks remain authoritative.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::webview::cookie::{time::OffsetDateTime, SameSite};
use tauri::{AppHandle, Manager, Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

#[cfg(target_os = "windows")]
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
#[cfg(target_os = "windows")]
use base64::{engine::general_purpose, Engine as _};
#[cfg(target_os = "windows")]
use rusqlite::{Connection, OpenFlags};
#[cfg(target_os = "windows")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::{LocalFree, HLOCAL},
    Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB},
};

const DEFAULT_ACCOUNT_ID: &str = "default";
const GENERATION_TIMEOUT: Duration = Duration::from_secs(390);
static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static GENERATING_ACCOUNTS: OnceLock<tokio::sync::Mutex<HashSet<String>>> = OnceLock::new();
static KEEPALIVE_STARTED: AtomicBool = AtomicBool::new(false);

// A small authenticated request is enough to keep an otherwise idle desktop
// session active.  Accounts are refreshed serially so the background task does
// not create hidden WebViews or cause UI frame drops.
const KEEPALIVE_INITIAL_DELAY: Duration = Duration::from_secs(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(2 * 60 * 60);
const KEEPALIVE_ACCOUNT_DELAY: Duration = Duration::from_millis(1500);
const DESKTOP_PROFILE_DISCOVERY_INTERVAL: Duration = Duration::from_secs(60);

// Keep the trailing slash. Doubao redirects `/v2` to `/v2/`; HTTP clients are
// allowed to remove sensitive headers such as Cookie while following that
// redirect, which made valid desktop sessions look expired (error code 13).
const DOUBAO_ACCOUNT_INFO_URL: &str =
    "https://www.doubao.com/passport/account/info/v2/?account_sdk_source=web";
const DOUBAO_LOGIN_VALIDATION_VERSION: u8 = 2;

#[derive(Debug, Clone)]
pub(crate) struct DoubaoSessionCheck {
    pub(crate) logged_in: bool,
    pub(crate) verified: bool,
    pub(crate) detail: Option<String>,
}

#[derive(Debug)]
pub(crate) struct DesktopCookieSyncResult {
    pub(crate) cookie_header: Option<String>,
    pub(crate) refreshed: bool,
    pub(crate) warning: Option<String>,
}

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
    #[serde(default)]
    desktop_profile_dir: Option<String>,
    #[serde(default)]
    desktop_cookie_sync_pending: bool,
    #[serde(default)]
    last_cookie_sync_at: u64,
    #[serde(default)]
    last_login_verified_at: u64,
    #[serde(default)]
    login_validation_version: u8,
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
    pub desktop_profile_dir: Option<String>,
    pub desktop_cookie_sync_pending: bool,
    pub last_cookie_sync_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoDesktopProfile {
    pub profile_dir: String,
    pub display_name: String,
    pub cookie_count: usize,
    pub has_cookie_database: bool,
    pub ready: bool,
    pub message: String,
    pub already_imported: bool,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoDesktopScan {
    pub install_path: Option<String>,
    pub user_data_dir: Option<String>,
    pub running: bool,
    pub profiles: Vec<DoubaoDesktopProfile>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoDesktopImportResult {
    pub state: DoubaoWebState,
    pub imported_account_ids: Vec<String>,
    pub message: String,
}

const PORTABLE_CREDENTIAL_FORMAT: &str = "cle-doubao-credential";
const PORTABLE_CREDENTIAL_VERSION: u8 = 1;
const MAX_PORTABLE_CREDENTIAL_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableDoubaoCookie {
    domain: String,
    path: String,
    name: String,
    value: String,
    expires_unix: Option<i64>,
    secure: bool,
    http_only: bool,
    same_site: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableDoubaoAccount {
    name: String,
    #[serde(default)]
    source_account_id: Option<String>,
    cookies: Vec<PortableDoubaoCookie>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableDoubaoCredentialFile {
    format: String,
    version: u8,
    exported_at: u64,
    accounts: Vec<PortableDoubaoAccount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoCredentialExportResult {
    pub json: String,
    pub account_count: usize,
    pub cookie_count: usize,
    pub skipped_accounts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoCredentialImportResult {
    pub state: DoubaoWebState,
    pub imported_account_ids: Vec<String>,
    pub cookie_count: usize,
    pub message: String,
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

fn store_backup_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("doubao-web-accounts.json.bak"))
}

fn portable_credential_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("doubao-portable-credentials"))
}

fn portable_credential_path(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    if !valid_account_id(account_id) {
        return Err("豆包凭证账号 ID 无效".into());
    }
    Ok(portable_credential_dir(app)?.join(format!("{account_id}.json")))
}

fn normalize_portable_cookie(cookie: &mut PortableDoubaoCookie) -> Result<(), String> {
    cookie.domain = cookie.domain.trim().to_ascii_lowercase();
    cookie.path = cookie.path.trim().to_string();
    cookie.name = cookie.name.trim().to_string();
    if cookie.path.is_empty() {
        cookie.path = "/".into();
    }
    let host = cookie.domain.trim_start_matches('.');
    if host != "doubao.com" && !host.ends_with(".doubao.com") {
        return Err(format!("凭证包含非豆包域 Cookie：{}", cookie.domain));
    }
    if cookie.name.is_empty()
        || cookie.name.len() > 256
        || cookie.value.is_empty()
        || cookie.value.len() > 65_536
        || cookie.path.len() > 2_048
    {
        return Err("豆包凭证包含无效或超长 Cookie".into());
    }
    cookie.same_site = cookie.same_site.as_deref().and_then(|value| {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" => Some("none".to_string()),
            "lax" => Some("lax".to_string()),
            "strict" => Some("strict".to_string()),
            _ => None,
        }
    });
    Ok(())
}

fn validate_portable_account(account: &mut PortableDoubaoAccount) -> Result<(), String> {
    account.name = normalized_name(&account.name, "导入的豆包账号");
    if account.cookies.is_empty() || account.cookies.len() > 512 {
        return Err(format!("{} 的 Cookie 数量无效", account.name));
    }
    for cookie in &mut account.cookies {
        normalize_portable_cookie(cookie)?;
    }
    let now = unix_timestamp() as i64;
    account
        .cookies
        .retain(|cookie| cookie.expires_unix.map_or(true, |expires| expires > now));
    let mut seen = HashSet::new();
    account.cookies.retain(|cookie| {
        seen.insert((
            cookie.domain.clone(),
            cookie.path.clone(),
            cookie.name.clone(),
        ))
    });
    if account.cookies.is_empty() {
        return Err(format!("{} 的 Cookie 已全部过期", account.name));
    }
    Ok(())
}

fn write_portable_account_file(
    app: &AppHandle,
    account_id: &str,
    account: &PortableDoubaoAccount,
) -> Result<(), String> {
    let path = portable_credential_path(app, account_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| "无法定位豆包凭证目录".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("创建豆包凭证目录失败: {error}"))?;
    let raw = serde_json::to_vec_pretty(account)
        .map_err(|error| format!("序列化豆包凭证失败: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, raw).map_err(|error| format!("写入豆包凭证失败: {error}"))?;
    std::fs::rename(&temporary, &path)
        .or_else(|_| {
            std::fs::copy(&temporary, &path).map(|_| ())?;
            std::fs::remove_file(&temporary)
        })
        .map_err(|error| format!("保存豆包凭证失败: {error}"))
}

fn read_portable_account_file(
    app: &AppHandle,
    account_id: &str,
) -> Result<Option<PortableDoubaoAccount>, String> {
    let path = portable_credential_path(app, account_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read(&path).map_err(|error| format!("读取豆包凭证失败: {error}"))?;
    if raw.len() > MAX_PORTABLE_CREDENTIAL_BYTES {
        return Err("豆包凭证文件过大".into());
    }
    let mut account: PortableDoubaoAccount =
        serde_json::from_slice(&raw).map_err(|error| format!("解析豆包凭证失败: {error}"))?;
    validate_portable_account(&mut account)?;
    Ok(Some(account))
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
        desktop_profile_dir: None,
        desktop_cookie_sync_pending: false,
        last_cookie_sync_at: 0,
        last_login_verified_at: 0,
        login_validation_version: 0,
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
    let mut store: DoubaoWebAccountStore = match serde_json::from_str(&raw) {
        Ok(store) => store,
        Err(primary_error) => {
            let backup_path = store_backup_path(app)?;
            let backup_raw = std::fs::read_to_string(&backup_path).map_err(|backup_error| {
                format!("网页创作账号配置格式损坏且备份不可用: {primary_error}; {backup_error}")
            })?;
            let store = serde_json::from_str(&backup_raw).map_err(|backup_error| {
                format!("网页创作账号配置与备份均已损坏: {primary_error}; {backup_error}")
            })?;
            // Restore the readable backup without first replacing it with the
            // corrupt primary file.
            std::fs::write(&path, backup_raw)
                .map_err(|error| format!("恢复网页创作账号配置备份失败: {error}"))?;
            store
        }
    };
    let mut ids = HashSet::new();
    let mut migrated_unverified_doubao_state = false;
    for account in &mut store.accounts {
        if !valid_account_id(&account.id)
            || !valid_platform_id(&account.platform_id)
            || !ids.insert(account.id.as_str())
        {
            return Err("网页创作账号配置包含无效或重复的账号 ID".into());
        }
        if account.platform_id == "doubao"
            && account.login_validation_version < DOUBAO_LOGIN_VALIDATION_VERSION
            && (account.last_known_logged_in || account.last_login_verified_at > 0)
        {
            account.last_known_logged_in = false;
            account.last_login_verified_at = 0;
            migrated_unverified_doubao_state = true;
        }
    }
    if store.accounts.is_empty() {
        store.accounts.push(default_account());
        write_store_unlocked(app, &store)?;
    } else if migrated_unverified_doubao_state {
        write_store_unlocked(app, &store)?;
    }
    Ok(store)
}

fn write_store_unlocked(app: &AppHandle, store: &DoubaoWebAccountStore) -> Result<(), String> {
    let path = store_path(app)?;
    let backup_path = store_backup_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建网页创作账号配置目录: {error}"))?;
    }
    let raw = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("无法序列化网页创作账号配置: {error}"))?;
    let temp_path = path.with_extension("json.tmp");
    {
        use std::io::Write as _;
        let mut file = std::fs::File::create(&temp_path)
            .map_err(|error| format!("无法创建网页创作账号临时配置: {error}"))?;
        file.write_all(&raw)
            .map_err(|error| format!("无法写入网页创作账号临时配置: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法同步网页创作账号临时配置: {error}"))?;
    }
    if path.is_file() {
        std::fs::copy(&path, &backup_path)
            .map_err(|error| format!("无法备份网页创作账号配置: {error}"))?;
    }
    std::fs::copy(&temp_path, &path)
        .map_err(|error| format!("无法保存网页创作账号配置: {error}"))?;
    let _ = std::fs::remove_file(temp_path);
    Ok(())
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

fn valid_desktop_profile_dir(value: &str) -> bool {
    value == "Default"
        || value.strip_prefix("Profile ").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit())
        })
}

#[cfg(target_os = "windows")]
fn doubao_desktop_user_data_dir() -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位 LOCALAPPDATA，不能读取豆包桌面版账号".to_string())?;
    Ok(local_app_data.join("Doubao").join("User Data"))
}

#[cfg(not(target_os = "windows"))]
fn doubao_desktop_user_data_dir() -> Result<PathBuf, String> {
    Err("从豆包桌面版导入 Cookie 当前仅支持 Windows".into())
}

#[cfg(target_os = "windows")]
fn doubao_install_path() -> Option<PathBuf> {
    [
        PathBuf::from(r"F:\Doubao\app\Doubao.exe"),
        PathBuf::from(r"F:\Doubao\Doubao.exe"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn doubao_is_running() -> bool {
    let mut system = sysinfo::System::new_all();
    system.refresh_all();
    system.processes().values().any(|process| {
        process
            .name()
            .to_string_lossy()
            .eq_ignore_ascii_case("doubao.exe")
    })
}

#[cfg(target_os = "windows")]
fn profile_display_names(root: &Path) -> HashMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(root.join("Local State")) else {
        return HashMap::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return HashMap::new();
    };
    json.pointer("/profile/info_cache")
        .and_then(Value::as_object)
        .map(|cache| {
            cache
                .iter()
                .filter_map(|(profile_dir, value)| {
                    valid_desktop_profile_dir(profile_dir).then(|| {
                        let name = value
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(profile_dir);
                        (profile_dir.clone(), normalized_name(name, profile_dir))
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn open_desktop_cookie_db(path: &Path) -> Result<Connection, String> {
    match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(connection) => Ok(connection),
        Err(primary_error) => {
            // Chromium keeps the active profile's Cookies database locked.
            // SQLite's immutable read-only URI gives us a non-mutating
            // snapshot of the last committed pages without asking the user to
            // close Doubao or touching its WAL/lock files.
            let mut uri = Url::from_file_path(path)
                .map_err(|_| format!("豆包 Cookie 数据库路径无效: {}", path.display()))?;
            uri.query_pairs_mut()
                .append_pair("mode", "ro")
                .append_pair("immutable", "1");
            Connection::open_with_flags(
                uri.as_str(),
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            )
            .map_err(|snapshot_error| {
                format!(
                    "Cookie 数据库正被豆包占用且只读快照也无法打开: {primary_error}; {snapshot_error}"
                )
            })
        }
    }
}

#[cfg(target_os = "windows")]
fn desktop_cookie_count(root: &Path, profile_dir: &str) -> Result<usize, String> {
    let path = root.join(profile_dir).join("Network").join("Cookies");
    if !path.is_file() {
        return Err("未找到 Cookie 数据库".into());
    }
    let connection = open_desktop_cookie_db(&path)?;
    connection
        .query_row(
            "select count(*) from cookies where host_key = 'doubao.com' or host_key like '%.doubao.com'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as usize)
        .map_err(|error| format!("读取豆包 Cookie 数量失败: {error}"))
}

pub fn scan_desktop_profiles(app: &AppHandle) -> Result<DoubaoDesktopScan, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("从豆包桌面版导入 Cookie 当前仅支持 Windows".into());
    }

    #[cfg(target_os = "windows")]
    {
        let root = doubao_desktop_user_data_dir()?;
        if !root.is_dir() {
            return Ok(DoubaoDesktopScan {
                install_path: doubao_install_path().map(|path| path.to_string_lossy().into_owned()),
                user_data_dir: Some(root.to_string_lossy().into_owned()),
                running: doubao_is_running(),
                profiles: Vec::new(),
                message: "未发现豆包桌面版用户数据".into(),
            });
        }
        let names = profile_display_names(&root);
        let mut profile_dirs: HashSet<String> = names.keys().cloned().collect();
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if valid_desktop_profile_dir(&name)
                    && entry.path().join("Network").join("Cookies").is_file()
                {
                    profile_dirs.insert(name);
                }
            }
        }
        let imported: HashMap<String, String> = load_store(app)?
            .accounts
            .into_iter()
            .filter_map(|account| {
                account
                    .desktop_profile_dir
                    .map(|profile_dir| (profile_dir, account.id))
            })
            .collect();
        let mut profile_dirs: Vec<String> = profile_dirs.into_iter().collect();
        profile_dirs.sort_by_key(|name| {
            if name == "Default" {
                0
            } else {
                name.strip_prefix("Profile ")
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(u32::MAX - 1)
                    .saturating_add(1)
            }
        });
        let profiles = profile_dirs
            .into_iter()
            .map(|profile_dir| {
                let has_cookie_database = root
                    .join(&profile_dir)
                    .join("Network")
                    .join("Cookies")
                    .is_file();
                let result = desktop_cookie_count(&root, &profile_dir);
                let cookie_count = result.as_ref().copied().unwrap_or(0);
                let ready = cookie_count > 0;
                let account_id = imported.get(&profile_dir).cloned();
                let message = match result {
                    Ok(0) => "未检测到 doubao.com 登录 Cookie".into(),
                    Ok(count) => format!("检测到 {count} 条豆包 Cookie，可直接导入"),
                    Err(error) => error,
                };
                DoubaoDesktopProfile {
                    display_name: names
                        .get(&profile_dir)
                        .cloned()
                        .unwrap_or_else(|| profile_dir.clone()),
                    profile_dir,
                    cookie_count,
                    has_cookie_database,
                    ready,
                    message,
                    already_imported: account_id.is_some(),
                    account_id,
                }
            })
            .collect::<Vec<_>>();
        let ready_count = profiles.iter().filter(|profile| profile.ready).count();
        Ok(DoubaoDesktopScan {
            install_path: doubao_install_path().map(|path| path.to_string_lossy().into_owned()),
            user_data_dir: Some(root.to_string_lossy().into_owned()),
            running: doubao_is_running(),
            message: format!(
                "发现 {} 个桌面 Profile，{} 个当前可导入",
                profiles.len(),
                ready_count
            ),
            profiles,
        })
    }
}

/// Keep the creator workspace account list in sync with the locally installed
/// Doubao desktop profiles. This only registers profile metadata; Cookie bytes
/// are copied lazily when that account is opened, so a running/locked desktop
/// profile cannot stall the whole workspace during startup.
#[cfg(target_os = "windows")]
fn reconcile_desktop_profile_records(app: &AppHandle) -> Result<usize, String> {
    let root = doubao_desktop_user_data_dir()?;
    if !root.is_dir() {
        return Ok(0);
    }

    let names = profile_display_names(&root);
    let mut profiles = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let profile_dir = entry.file_name().to_string_lossy().into_owned();
            if valid_desktop_profile_dir(&profile_dir)
                && entry.path().join("Network").join("Cookies").is_file()
            {
                profiles.insert(profile_dir);
            }
        }
    }
    if profiles.is_empty() {
        return Ok(0);
    }

    let mut profiles = profiles.into_iter().collect::<Vec<_>>();
    profiles.sort_by_key(|name| {
        if name == "Default" {
            0
        } else {
            name.strip_prefix("Profile ")
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(u32::MAX - 1)
                .saturating_add(1)
        }
    });

    let existing = load_store(app)?;
    let has_desktop_accounts = existing
        .accounts
        .iter()
        .any(|account| account.desktop_profile_dir.is_some());
    let has_legacy_placeholders = has_desktop_accounts
        && existing.accounts.iter().any(|account| {
            account.platform_id == "doubao"
                && account.desktop_profile_dir.is_none()
                && !account.enabled
                && !account.last_known_logged_in
                && account.last_used_at == 0
                && account.last_cookie_sync_at == 0
                && account.last_login_verified_at == 0
                && account.name.starts_with("豆包账号 ")
        });
    let known = existing
        .accounts
        .iter()
        .filter_map(|account| account.desktop_profile_dir.as_deref())
        .collect::<HashSet<_>>();
    let missing = profiles
        .into_iter()
        .filter(|profile_dir| !known.contains(profile_dir.as_str()))
        .collect::<Vec<_>>();
    if missing.is_empty() && !has_legacy_placeholders {
        return Ok(0);
    }
    update_store(app, |store| {
        let mut added = 0usize;
        // Old builds created disabled empty shells before desktop-profile
        // import existed. Once real desktop accounts are present these shells
        // only hide the usable accounts below the fold, so remove only the
        // untouched legacy pattern and preserve every user-created account.
        if has_legacy_placeholders {
            store.accounts.retain(|account| {
                !(account.platform_id == "doubao"
                    && account.desktop_profile_dir.is_none()
                    && !account.enabled
                    && !account.last_known_logged_in
                    && account.last_used_at == 0
                    && account.last_cookie_sync_at == 0
                    && account.last_login_verified_at == 0
                    && account.name.starts_with("豆包账号 "))
            });
        }
        for profile_dir in missing {
            // React can request state more than once during startup. Re-check
            // under the store lock so concurrent reconciliation stays
            // idempotent and never creates duplicate profile records.
            if store
                .accounts
                .iter()
                .any(|account| account.desktop_profile_dir.as_deref() == Some(profile_dir.as_str()))
            {
                continue;
            }
            if store.accounts.len() >= 50 {
                return Err("自动同步豆包桌面账号后将超过 50 个网页创作账号".into());
            }
            store.accounts.push(DoubaoWebAccountRecord {
                id: uuid::Uuid::new_v4().simple().to_string(),
                name: normalized_name(
                    names.get(&profile_dir).map(String::as_str).unwrap_or(""),
                    &profile_dir,
                ),
                platform_id: "doubao".into(),
                enabled: true,
                last_known_logged_in: false,
                last_error: "已发现豆包桌面账号，首次打开时同步登录凭证".into(),
                consecutive_failures: 0,
                last_used_at: 0,
                desktop_profile_dir: Some(profile_dir),
                desktop_cookie_sync_pending: true,
                last_cookie_sync_at: 0,
                last_login_verified_at: 0,
                login_validation_version: 0,
            });
            added += 1;
        }
        Ok(added)
    })
}

#[cfg(not(target_os = "windows"))]
fn reconcile_desktop_profile_records(_app: &AppHandle) -> Result<usize, String> {
    Ok(0)
}

#[cfg(target_os = "windows")]
fn dpapi_decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: encrypted.len() as u32,
            pbData: encrypted.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output)
            .map_err(|error| format!("Windows DPAPI 解密豆包 Cookie 密钥失败: {error}"))?;
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(result)
    }
}

#[cfg(target_os = "windows")]
fn desktop_cookie_key(root: &Path) -> Result<Vec<u8>, String> {
    let raw = std::fs::read_to_string(root.join("Local State"))
        .map_err(|error| format!("读取豆包 Local State 失败: {error}"))?;
    let json: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("解析豆包 Local State 失败: {error}"))?;
    let encoded = json
        .pointer("/os_crypt/encrypted_key")
        .and_then(Value::as_str)
        .ok_or_else(|| "豆包 Local State 缺少 Cookie 加密密钥".to_string())?;
    let encrypted = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("解析豆包 Cookie 加密密钥失败: {error}"))?;
    let payload = encrypted
        .strip_prefix(b"DPAPI")
        .ok_or_else(|| "豆包 Cookie 密钥不是当前支持的 Windows DPAPI 格式".to_string())?;
    let key = dpapi_decrypt(payload)?;
    if key.len() != 32 {
        return Err(format!("豆包 Cookie AES 密钥长度异常: {}", key.len()));
    }
    Ok(key)
}

#[cfg(target_os = "windows")]
fn decrypt_desktop_cookie(
    key: &[u8],
    domain: &str,
    encrypted: &[u8],
    database_version: i64,
) -> Result<String, String> {
    if encrypted.len() < 31 || !encrypted.starts_with(b"v10") {
        return Err("Cookie 不是当前支持的 Chromium v10 格式".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("初始化 Cookie 解密器失败: {error}"))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&encrypted[3..15]), &encrypted[15..])
        .map_err(|_| "Cookie AES-GCM 解密失败".to_string())?;
    let plaintext = if database_version >= 24 {
        let digest = Sha256::digest(domain.as_bytes());
        plaintext
            .strip_prefix(digest.as_slice())
            .ok_or_else(|| format!("Cookie 域校验失败，拒绝导入 {domain} 的异常数据"))?
    } else {
        plaintext.as_slice()
    };
    String::from_utf8(plaintext.to_vec()).map_err(|_| "Cookie 内容不是有效 UTF-8".into())
}

#[cfg(target_os = "windows")]
struct DesktopCookie {
    domain: String,
    path: String,
    name: String,
    value: String,
    expires_unix: Option<i64>,
    secure: bool,
    http_only: bool,
    same_site: i64,
}

#[cfg(target_os = "windows")]
impl From<DesktopCookie> for PortableDoubaoCookie {
    fn from(cookie: DesktopCookie) -> Self {
        Self {
            domain: cookie.domain,
            path: cookie.path,
            name: cookie.name,
            value: cookie.value,
            expires_unix: cookie.expires_unix,
            secure: cookie.secure,
            http_only: cookie.http_only,
            same_site: match cookie.same_site {
                0 => Some("none".into()),
                1 => Some("lax".into()),
                2 => Some("strict".into()),
                _ => None,
            },
        }
    }
}

#[cfg(target_os = "windows")]
fn read_desktop_cookies(root: &Path, profile_dir: &str) -> Result<Vec<DesktopCookie>, String> {
    if !valid_desktop_profile_dir(profile_dir) {
        return Err("豆包桌面 Profile 名称无效".into());
    }
    let key = desktop_cookie_key(root)?;
    let connection =
        open_desktop_cookie_db(&root.join(profile_dir).join("Network").join("Cookies"))?;
    let database_version = connection
        .query_row("select value from meta where key = 'version'", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default();
    let mut statement = connection
        .prepare(
            "select host_key, path, name, value, encrypted_value, expires_utc, is_secure, is_httponly, samesite \
             from cookies where host_key = 'doubao.com' or host_key like '%.doubao.com'",
        )
        .map_err(|error| format!("读取豆包 Cookie 表失败: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Vec<u8>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|error| format!("查询豆包 Cookie 失败: {error}"))?;
    let now = unix_timestamp() as i64;
    let mut cookies = Vec::new();
    for row in rows {
        let (domain, path, name, plain, encrypted, expires_utc, secure, http_only, same_site) =
            row.map_err(|error| format!("解析豆包 Cookie 行失败: {error}"))?;
        let expires_unix = (expires_utc > 0).then(|| expires_utc / 1_000_000 - 11_644_473_600);
        if expires_unix.is_some_and(|expires| expires <= now) {
            continue;
        }
        let value = if !plain.is_empty() {
            plain
        } else if !encrypted.is_empty() {
            decrypt_desktop_cookie(&key, &domain, &encrypted, database_version)?
        } else {
            continue;
        };
        if value.is_empty() || name.is_empty() {
            continue;
        }
        cookies.push(DesktopCookie {
            domain,
            path: if path.is_empty() { "/".into() } else { path },
            name,
            value,
            expires_unix,
            secure: secure != 0,
            http_only: http_only != 0,
            same_site,
        });
    }
    if cookies.is_empty() {
        return Err(format!("{profile_dir} 没有可导入的有效豆包 Cookie"));
    }
    Ok(cookies)
}

#[cfg(target_os = "windows")]
fn desktop_cookie_header(cookies: &[DesktopCookie]) -> String {
    cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(target_os = "windows")]
fn multi_sid_from_local_state(
    local_state: &Value,
    profile_dir: &str,
) -> Result<(String, String), String> {
    let user_id = local_state
        .pointer("/profile/info_cache")
        .and_then(Value::as_object)
        .and_then(|profiles| profiles.get(profile_dir))
        .and_then(|profile| profile.pointer("/saman/user_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{profile_dir} 缺少豆包用户 ID"))?;
    let enterprise = local_state
        .pointer("/saman/local_storage_app_for_web/enterprise")
        .and_then(Value::as_str)
        .ok_or_else(|| "豆包 Local State 缺少多账号登录信息".to_string())?;
    let enterprise: Value = serde_json::from_str(enterprise)
        .map_err(|error| format!("解析豆包多账号登录信息失败: {error}"))?;
    let encoded_multi_sids = enterprise
        .get("x-tt-multi-sids")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "豆包桌面版没有保存多账号会话".to_string())?;
    let decoded = urlencoding::decode(encoded_multi_sids)
        .map_err(|error| format!("解析豆包多账号会话失败: {error}"))?;
    let sid = decoded
        .split('|')
        .filter_map(|entry| entry.split_once(':'))
        .find_map(|(entry_user_id, sid)| (entry_user_id == user_id).then_some(sid))
        .filter(|sid| !sid.is_empty())
        .ok_or_else(|| format!("{profile_dir} 不在豆包桌面版的有效多账号会话中"))?;
    Ok((sid.to_string(), encoded_multi_sids.to_string()))
}

#[cfg(target_os = "windows")]
fn desktop_multi_sid(root: &Path, profile_dir: &str) -> Result<(String, String), String> {
    let raw = std::fs::read_to_string(root.join("Local State"))
        .map_err(|error| format!("读取豆包 Local State 失败: {error}"))?;
    let local_state: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("解析豆包 Local State 失败: {error}"))?;
    multi_sid_from_local_state(&local_state, profile_dir)
}

#[cfg(target_os = "windows")]
fn sync_multi_sid_to_view(
    root: &Path,
    profile_dir: &str,
    view: &Webview,
) -> Result<String, String> {
    let (sid, multi_sids) = desktop_multi_sid(root, profile_dir)?;
    let session_cookie_names = [
        "sessionid",
        "sessionid_ss",
        "sid_tt",
        "sid_ucp_v1",
        "ssid_ucp_v1",
    ];
    for name in session_cookie_names {
        for domain in [".doubao.com", "www.doubao.com"] {
            let cookie = tauri::webview::Cookie::build((name.to_string(), sid.clone()))
                .domain(domain)
                .path("/")
                .secure(true)
                .http_only(true)
                .same_site(SameSite::None)
                .build();
            view.set_cookie(cookie)
                .map_err(|error| format!("写入豆包多账号会话失败: {error}"))?;
        }
    }
    for domain in [".doubao.com", "www.doubao.com"] {
        let cookie = tauri::webview::Cookie::build(("multi_sids".to_string(), multi_sids.clone()))
            .domain(domain)
            .path("/")
            .secure(true)
            .http_only(true)
            .same_site(SameSite::None)
            .build();
        view.set_cookie(cookie)
            .map_err(|error| format!("写入豆包多账号列表失败: {error}"))?;
    }
    Ok(format!(
        "sessionid={sid}; sessionid_ss={sid}; sid_tt={sid}; sid_ucp_v1={sid}; ssid_ucp_v1={sid}; multi_sids={multi_sids}"
    ))
}

#[cfg(target_os = "windows")]
fn write_desktop_cookie_to_view(
    view: &Webview,
    item: &DesktopCookie,
    domain: &str,
) -> Result<(), String> {
    let mut builder = tauri::webview::Cookie::build((item.name.clone(), item.value.clone()))
        .domain(domain.to_string())
        .path(item.path.clone())
        .secure(item.secure)
        .http_only(item.http_only);
    builder = match item.same_site {
        0 => builder.same_site(SameSite::None),
        1 => builder.same_site(SameSite::Lax),
        2 => builder.same_site(SameSite::Strict),
        _ => builder,
    };
    if let Some(expires) = item
        .expires_unix
        .and_then(|value| OffsetDateTime::from_unix_timestamp(value).ok())
    {
        builder = builder.expires(expires);
    }
    view.set_cookie(builder.build())
        .map_err(|error| format!("写入豆包 Cookie 失败: {error}"))
}

fn write_portable_cookie_to_view(
    view: &Webview,
    item: &PortableDoubaoCookie,
    domain: &str,
) -> Result<(), String> {
    let mut builder = tauri::webview::Cookie::build((item.name.clone(), item.value.clone()))
        .domain(domain.to_string())
        .path(item.path.clone())
        .secure(item.secure)
        .http_only(item.http_only);
    builder = match item.same_site.as_deref() {
        Some("none") => builder.same_site(SameSite::None),
        Some("lax") => builder.same_site(SameSite::Lax),
        Some("strict") => builder.same_site(SameSite::Strict),
        _ => builder,
    };
    if let Some(expires) = item
        .expires_unix
        .and_then(|value| OffsetDateTime::from_unix_timestamp(value).ok())
    {
        builder = builder.expires(expires);
    }
    view.set_cookie(builder.build())
        .map_err(|error| format!("写入可迁移豆包 Cookie 失败: {error}"))
}

pub(crate) fn sync_portable_cookies_to_view(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
    view: &Webview,
) -> Result<Option<DesktopCookieSyncResult>, String> {
    if account.platform_id != "doubao" {
        return Ok(None);
    }
    let Some(portable) = read_portable_account_file(app, &account.id)? else {
        return Ok(None);
    };
    let cookie_header = portable
        .cookies
        .iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ");
    for cookie in &portable.cookies {
        write_portable_cookie_to_view(view, cookie, &cookie.domain)?;
        if matches!(cookie.domain.as_str(), "doubao.com" | ".doubao.com") {
            write_portable_cookie_to_view(view, cookie, "www.doubao.com")?;
        }
    }
    update_store(app, |store| {
        let record = store
            .accounts
            .iter_mut()
            .find(|record| record.id == account.id)
            .ok_or_else(|| "导入目标账号不存在".to_string())?;
        record.desktop_cookie_sync_pending = false;
        record.last_cookie_sync_at = unix_timestamp();
        record.last_known_logged_in = false;
        record.last_login_verified_at = 0;
        record.login_validation_version = 0;
        record.last_error.clear();
        Ok(())
    })?;
    Ok(Some(DesktopCookieSyncResult {
        cookie_header: Some(cookie_header),
        refreshed: true,
        warning: None,
    }))
}

pub(crate) fn finalize_portable_cookie_import(
    app: &AppHandle,
    account_id: &str,
    verified_logged_in: bool,
) {
    if !verified_logged_in {
        return;
    }
    // After the destination WebView has persisted and the server has accepted
    // the session, remove the plaintext bootstrap copy. Future refreshes then
    // come from the destination browser profile instead of an aging export
    // file overwriting newer cookies on every open.
    if let Ok(path) = portable_credential_path(app, account_id) {
        let _ = std::fs::remove_file(path);
    }
}

pub(crate) fn synced_cookie_header(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
) -> Result<Option<String>, String> {
    if account.platform_id != "doubao" || account.last_cookie_sync_at == 0 {
        return Ok(None);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, account);
        Ok(None)
    }
    #[cfg(target_os = "windows")]
    {
        let root = browser_data_dir(app, account)?.join("EBWebView");
        if !root.join("Local State").is_file() {
            return Ok(None);
        }
        read_desktop_cookies(&root, "Default").map(|cookies| Some(desktop_cookie_header(&cookies)))
    }
}

pub(crate) fn sync_desktop_cookies_to_view(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
    view: &Webview,
) -> Result<Option<DesktopCookieSyncResult>, String> {
    let Some(profile_dir) = account.desktop_profile_dir.as_deref() else {
        return Ok(None);
    };
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, profile_dir, view);
        return Err("从豆包桌面版导入 Cookie 当前仅支持 Windows".into());
    }

    #[cfg(target_os = "windows")]
    {
        let root = doubao_desktop_user_data_dir()?;
        // Always refresh on an explicit account open. Besides picking up a
        // desktop-side account switch, this migrates profiles created before
        // v1.1.18 whose `.doubao.com` cookies were normalized by WebView2 into
        // unusable host-only `doubao.com` cookies.
        let should_refresh = true;
        let cookies = match read_desktop_cookies(&root, profile_dir) {
            Ok(cookies) => cookies,
            Err(cookie_error) => match sync_multi_sid_to_view(&root, profile_dir, view) {
                Ok(cookie_header) => {
                    // Chromium exclusively locks the active profile's Cookie
                    // database. Doubao also persists that profile's session in
                    // its multi-account Local State, which stays readable while
                    // the app is running. Import that exact session instead of
                    // asking the user to close Doubao or log in again.
                    let warning = format!(
                        "桌面账号 {profile_dir} 的 Cookie 数据库正在使用，已从豆包多账号会话同步；解锁后会自动补全 Cookie"
                    );
                    update_store(app, |store| {
                        let record = store
                            .accounts
                            .iter_mut()
                            .find(|record| record.id == account.id)
                            .ok_or_else(|| "导入目标账号不存在".to_string())?;
                        record.desktop_cookie_sync_pending = true;
                        record.last_cookie_sync_at = unix_timestamp();
                        record.last_known_logged_in = false;
                        record.last_login_verified_at = 0;
                        record.login_validation_version = 0;
                        record.last_error = warning.clone();
                        Ok(())
                    })?;
                    return Ok(Some(DesktopCookieSyncResult {
                        cookie_header: Some(cookie_header),
                        refreshed: true,
                        warning: Some(warning),
                    }));
                }
                Err(multi_sid_error) if account.last_cookie_sync_at > 0 => {
                    // The active Doubao profile may hold an exclusive lock. Keep
                    // the last known WebView snapshot usable and retry next open;
                    // never turn a transient source lock into a broken account.
                    let warning = format!(
                    "桌面账号 {profile_dir} 当前被豆包占用，继续使用上次同步的登录凭证；下次打开会自动重试：{cookie_error}；多账号会话回退不可用：{multi_sid_error}"
                );
                    update_store(app, |store| {
                        if let Some(record) = store
                            .accounts
                            .iter_mut()
                            .find(|record| record.id == account.id)
                        {
                            record.desktop_cookie_sync_pending = true;
                            record.last_error = warning.clone();
                        }
                        Ok(())
                    })?;
                    return Ok(Some(DesktopCookieSyncResult {
                        cookie_header: None,
                        refreshed: false,
                        warning: Some(warning),
                    }));
                }
                Err(multi_sid_error) => {
                    return Err(format!(
                        "{cookie_error}；豆包多账号会话也无法导入：{multi_sid_error}"
                    ));
                }
            },
        };
        let cookie_header = desktop_cookie_header(&cookies);
        if should_refresh {
            for item in &cookies {
                write_desktop_cookie_to_view(view, item, &item.domain)?;
                // Wry/WebView2 currently normalizes `.doubao.com` to a
                // host-only `doubao.com` cookie. The actual creator page runs
                // on `www.doubao.com`, so write a valid host cookie there as
                // well instead of editing Chromium's encrypted database.
                if matches!(item.domain.as_str(), "doubao.com" | ".doubao.com") {
                    write_desktop_cookie_to_view(view, item, "www.doubao.com")?;
                }
            }
            update_store(app, |store| {
                let record = store
                    .accounts
                    .iter_mut()
                    .find(|record| record.id == account.id)
                    .ok_or_else(|| "导入目标账号不存在".to_string())?;
                record.desktop_cookie_sync_pending = false;
                record.last_cookie_sync_at = unix_timestamp();
                // Copying cookies is not proof of a live session. The caller
                // validates this exact header against Doubao before marking it
                // online.
                record.last_known_logged_in = false;
                record.last_login_verified_at = 0;
                record.login_validation_version = 0;
                record.last_error.clear();
                Ok(())
            })?;
        }
        Ok(Some(DesktopCookieSyncResult {
            cookie_header: Some(cookie_header),
            refreshed: should_refresh,
            warning: None,
        }))
    }
}

fn non_empty_json_identity(value: &Value) -> bool {
    const IDENTITY_KEYS: &[&str] = &[
        "user_id",
        "user_id_str",
        "userId",
        "uid",
        "sec_user_id",
        "secUid",
        "screen_name",
        "screenName",
        "nickname",
    ];
    let Some(object) = value.as_object() else {
        return false;
    };
    IDENTITY_KEYS.iter().any(|key| {
        object.get(*key).is_some_and(|item| match item {
            Value::String(text) => !text.trim().is_empty(),
            Value::Number(_) => true,
            _ => false,
        })
    })
}

fn response_error_code(value: &Value) -> Option<i64> {
    value
        .pointer("/data/error_code")
        .or_else(|| value.pointer("/data/errorCode"))
        .or_else(|| value.get("error_code"))
        .or_else(|| value.get("errorCode"))
        .and_then(|code| {
            code.as_i64()
                .or_else(|| code.as_str().and_then(|text| text.parse().ok()))
        })
}

fn doubao_account_response_authenticated(value: &Value) -> bool {
    if response_error_code(value).is_some_and(|code| code != 0) {
        return false;
    }
    let data = value.get("data").unwrap_or(value);
    non_empty_json_identity(data)
        || data.get("user").is_some_and(non_empty_json_identity)
        || data.get("account").is_some_and(non_empty_json_identity)
}

pub(crate) async fn validate_doubao_cookie_header(cookie_header: String) -> DoubaoSessionCheck {
    if cookie_header.trim().is_empty() {
        return DoubaoSessionCheck {
            logged_in: false,
            verified: true,
            detail: Some("没有可用于登录验证的豆包 Cookie".into()),
        };
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        )
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return DoubaoSessionCheck {
                logged_in: false,
                verified: false,
                detail: Some(format!("无法创建豆包登录验证请求: {error}")),
            };
        }
    };
    let response = match client
        .get(DOUBAO_ACCOUNT_INFO_URL)
        .query(&[
            ("sdk_version", "2.2.5"),
            ("language", "zh"),
            ("browser_language", "zh-CN"),
            ("device_platform", "web"),
            ("doubao_device_platform", "web"),
            ("aid", "582478"),
            ("real_aid", "582478"),
            ("pkg_type", "release_version"),
            ("use-olympus-account", "1"),
            ("samantha_web", "1"),
        ])
        .header(reqwest::header::COOKIE, cookie_header)
        .header(reqwest::header::ORIGIN, "https://www.doubao.com")
        .header(reqwest::header::REFERER, "https://www.doubao.com/chat/")
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return DoubaoSessionCheck {
                logged_in: false,
                verified: false,
                detail: Some(format!("豆包服务端登录验证失败: {error}")),
            };
        }
    };
    if !response.status().is_success() {
        return DoubaoSessionCheck {
            logged_in: false,
            verified: false,
            detail: Some(format!("豆包服务端登录验证返回 HTTP {}", response.status())),
        };
    }
    let value = match response.json::<Value>().await {
        Ok(value) => value,
        Err(error) => {
            return DoubaoSessionCheck {
                logged_in: false,
                verified: false,
                detail: Some(format!("豆包登录验证响应无法解析: {error}")),
            };
        }
    };
    if doubao_account_response_authenticated(&value) {
        DoubaoSessionCheck {
            logged_in: true,
            verified: true,
            detail: None,
        }
    } else if let Some(code) = response_error_code(&value) {
        DoubaoSessionCheck {
            logged_in: false,
            verified: true,
            detail: Some(if code == 13 {
                "豆包服务端判定会话已过期；需要先让桌面端刷新该账号，再重新导入".into()
            } else {
                format!("豆包服务端拒绝当前会话（错误码 {code}）")
            }),
        }
    } else {
        // Unknown response shapes are not allowed to turn an account green.
        DoubaoSessionCheck {
            logged_in: false,
            verified: false,
            detail: Some("豆包登录验证响应缺少可确认的账号身份".into()),
        }
    }
}

pub(crate) fn cached_doubao_session_check(
    app: &AppHandle,
    account_id: &str,
) -> Result<DoubaoSessionCheck, String> {
    let account = find_account(app, account_id)?;
    let verified = account.login_validation_version >= DOUBAO_LOGIN_VALIDATION_VERSION;
    Ok(DoubaoSessionCheck {
        logged_in: verified && account.last_known_logged_in,
        verified,
        detail: if !verified {
            Some("该账号尚未完成安全的服务端登录验证".into())
        } else if !account.last_known_logged_in && !account.last_error.is_empty() {
            Some(account.last_error)
        } else {
            None
        },
    })
}

pub(crate) fn update_session_check(
    app: &AppHandle,
    account_id: &str,
    check: &DoubaoSessionCheck,
) -> Result<(), String> {
    update_store(app, |store| {
        if let Some(account) = store
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
        {
            account.last_known_logged_in = check.logged_in;
            if check.verified {
                account.last_login_verified_at = unix_timestamp();
                account.login_validation_version = DOUBAO_LOGIN_VALIDATION_VERSION;
            } else {
                account.last_login_verified_at = 0;
                account.login_validation_version = 0;
            }
            account.last_error = check.detail.clone().unwrap_or_default();
        }
        Ok(())
    })
}

fn keepalive_cookie_header(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    if let Some(profile_dir) = account.desktop_profile_dir.as_deref() {
        let root = doubao_desktop_user_data_dir()?;
        match read_desktop_cookies(&root, profile_dir) {
            Ok(cookies) => return Ok(Some(desktop_cookie_header(&cookies))),
            Err(cookie_error) => match desktop_multi_sid(&root, profile_dir) {
                Ok((sid, multi_sids)) => {
                    return Ok(Some(format!(
                        "sessionid={sid}; sessionid_ss={sid}; sid_tt={sid}; \
                         sid_ucp_v1={sid}; ssid_ucp_v1={sid}; multi_sids={multi_sids}"
                    )));
                }
                Err(multi_sid_error) => {
                    if let Some(cookie_header) = synced_cookie_header(app, account)? {
                        return Ok(Some(cookie_header));
                    }
                    return Err(format!(
                        "无法读取桌面 Cookie，也无法读取多账号会话: {cookie_error}; {multi_sid_error}"
                    ));
                }
            },
        }
    }
    synced_cookie_header(app, account)
}

/// Refresh every enabled Doubao account without creating hidden browser
/// windows. Transient network/read errors never overwrite the last verified
/// state; an authoritative server response does.
pub(crate) async fn run_keepalive_cycle(app: &AppHandle) -> Result<(usize, usize), String> {
    let accounts: Vec<DoubaoWebAccountRecord> = load_store(app)?
        .accounts
        .into_iter()
        .filter(|account| account.enabled && account.platform_id == "doubao")
        .collect();
    let mut verified_checks = Vec::new();
    let mut errors = Vec::new();

    for (index, account) in accounts.iter().enumerate() {
        let app_handle = app.clone();
        let account_for_read = account.clone();
        let cookie_header = match tokio::task::spawn_blocking(move || {
            keepalive_cookie_header(&app_handle, &account_for_read)
        })
        .await
        {
            Ok(Ok(Some(cookie_header))) if !cookie_header.trim().is_empty() => cookie_header,
            Ok(Ok(_)) => {
                errors.push(format!("{} 没有可刷新的 Cookie", account.name));
                continue;
            }
            Ok(Err(error)) => {
                errors.push(format!("{}: {error}", account.name));
                continue;
            }
            Err(error) => {
                errors.push(format!("{} Cookie 读取任务失败: {error}", account.name));
                continue;
            }
        };

        let check = validate_doubao_cookie_header(cookie_header).await;
        if check.verified {
            verified_checks.push((account.id.clone(), check));
        } else {
            errors.push(format!(
                "{}: {}",
                account.name,
                check
                    .detail
                    .unwrap_or_else(|| "服务端未返回可确认的登录状态".into())
            ));
        }
        if index + 1 < accounts.len() {
            tokio::time::sleep(KEEPALIVE_ACCOUNT_DELAY).await;
        }
    }

    if !verified_checks.is_empty() {
        update_store(app, |store| {
            let now = unix_timestamp();
            for (account_id, check) in &verified_checks {
                if let Some(account) = store
                    .accounts
                    .iter_mut()
                    .find(|account| account.id == *account_id)
                {
                    account.last_known_logged_in = check.logged_in;
                    account.last_login_verified_at = now;
                    account.login_validation_version = DOUBAO_LOGIN_VALIDATION_VERSION;
                    account.last_error = check.detail.clone().unwrap_or_default();
                }
            }
            Ok(())
        })?;
    }

    if !errors.is_empty() {
        crate::logger::log_warn(&format!(
            "[DoubaoKeepalive] 本轮有 {} 个账号未刷新: {}",
            errors.len(),
            errors.join(" | ")
        ));
    }
    Ok((verified_checks.len(), errors.len()))
}

pub(crate) fn ensure_keepalive_started(app: AppHandle) {
    if KEEPALIVE_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let discovery_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match reconcile_desktop_profile_records(&discovery_app) {
                Ok(added) if added > 0 => crate::logger::log_info(&format!(
                    "[DoubaoKeepalive] 自动发现并加入 {added} 个豆包桌面账号"
                )),
                Ok(_) => {}
                Err(error) => crate::logger::log_warn(&format!(
                    "[DoubaoKeepalive] 自动发现豆包桌面账号失败: {error}"
                )),
            }
            tokio::time::sleep(DESKTOP_PROFILE_DISCOVERY_INTERVAL).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(KEEPALIVE_INITIAL_DELAY).await;
        loop {
            match run_keepalive_cycle(&app).await {
                Ok((refreshed, errors)) => crate::logger::log_info(&format!(
                    "[DoubaoKeepalive] 定时刷新完成: refreshed={refreshed}, errors={errors}"
                )),
                Err(error) => crate::logger::log_warn(&format!(
                    "[DoubaoKeepalive] 定时刷新失败，保留原账号状态: {error}"
                )),
            }
            tokio::time::sleep(KEEPALIVE_INTERVAL).await;
        }
    });
}

pub async fn import_desktop_profiles(
    app: AppHandle,
    profile_dirs: Vec<String>,
) -> Result<DoubaoDesktopImportResult, String> {
    if profile_dirs.is_empty() {
        return Err("请至少选择一个豆包桌面账号".into());
    }
    let mut unique = HashSet::new();
    let profile_dirs: Vec<String> = profile_dirs
        .into_iter()
        .filter(|profile| unique.insert(profile.clone()))
        .collect();
    if profile_dirs.len() > 20
        || profile_dirs
            .iter()
            .any(|profile| !valid_desktop_profile_dir(profile))
    {
        return Err("豆包桌面 Profile 列表无效".into());
    }
    let scan = scan_desktop_profiles(&app)?;
    let selected: Vec<DoubaoDesktopProfile> = profile_dirs
        .iter()
        .map(|profile_dir| {
            scan.profiles
                .iter()
                .find(|profile| profile.profile_dir == *profile_dir)
                .cloned()
                .ok_or_else(|| format!("没有发现豆包桌面 Profile：{profile_dir}"))
        })
        .collect::<Result<_, _>>()?;
    for profile in &selected {
        if !profile.has_cookie_database {
            return Err(format!(
                "{} 没有 Cookie 数据库，不能登记：{}",
                profile.display_name, profile.message
            ));
        }
    }

    let imported_account_ids = update_store(&app, |store| {
        if store.accounts.len()
            + selected
                .iter()
                .filter(|profile| !profile.already_imported)
                .count()
            > 50
        {
            return Err("导入后网页创作账号将超过 50 个".into());
        }
        let mut account_ids = Vec::new();
        for profile in &selected {
            if let Some(account) = store.accounts.iter_mut().find(|account| {
                account.desktop_profile_dir.as_deref() == Some(profile.profile_dir.as_str())
            }) {
                account.desktop_cookie_sync_pending = profile.has_cookie_database;
                account.enabled = true;
                account.last_known_logged_in = false;
                account.last_login_verified_at = 0;
                account.login_validation_version = 0;
                account.last_error = if profile.ready {
                    String::new()
                } else {
                    format!("桌面 Cookie 当前不可读取：{}", profile.message)
                };
                account_ids.push(account.id.clone());
                continue;
            }
            let account = DoubaoWebAccountRecord {
                id: uuid::Uuid::new_v4().simple().to_string(),
                name: normalized_name(&profile.display_name, &profile.profile_dir),
                platform_id: "doubao".into(),
                enabled: true,
                last_known_logged_in: false,
                last_error: if profile.ready {
                    String::new()
                } else {
                    format!("桌面 Cookie 当前不可读取：{}", profile.message)
                },
                consecutive_failures: 0,
                last_used_at: 0,
                desktop_profile_dir: Some(profile.profile_dir.clone()),
                desktop_cookie_sync_pending: profile.has_cookie_database,
                last_cookie_sync_at: 0,
                last_login_verified_at: 0,
                login_validation_version: 0,
            };
            account_ids.push(account.id.clone());
            store.accounts.push(account);
        }
        Ok(account_ids)
    })?;
    let selected_account_id = imported_account_ids.first().cloned();
    let state = build_state(&app, selected_account_id).await?;
    let cookie_ready_count = selected.iter().filter(|profile| profile.ready).count();
    Ok(DoubaoDesktopImportResult {
        message: format!(
            "已登记 {} 个豆包桌面账号，其中 {} 个当前可同步；被占用的账号也已保留，切换或下次打开时会自动重试",
            imported_account_ids.len(), cookie_ready_count
        ),
        state,
        imported_account_ids,
    })
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
    let cached_verified = account.platform_id == "doubao"
        && account.login_validation_version >= DOUBAO_LOGIN_VALIDATION_VERSION;
    if let Some((current_url, logged_in, status_verified, validation_detail)) =
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
            status_verified,
            current_url,
            message: if !account.enabled {
                "已停用，不参与自动故障切换".into()
            } else if busy {
                "正在生成视频".into()
            } else if logged_in {
                format!("{}网页登录状态可用", platform.name)
            } else {
                validation_detail.unwrap_or_else(|| {
                    if status_verified {
                        format!("请在当前工作台中完成{}登录或扫码确认", platform.name)
                    } else {
                        format!("暂时无法向{}服务端确认登录状态", platform.name)
                    }
                })
            },
            last_error: (!account.last_error.is_empty()).then(|| account.last_error.clone()),
            consecutive_failures: account.consecutive_failures,
            desktop_profile_dir: account.desktop_profile_dir.clone(),
            desktop_cookie_sync_pending: account.desktop_cookie_sync_pending,
            last_cookie_sync_at: (account.last_cookie_sync_at > 0)
                .then_some(account.last_cookie_sync_at),
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
            status_verified: cached_verified,
            current_url: None,
            message: if !account.enabled {
                "已停用，不参与自动故障切换".into()
            } else if busy {
                "正在生成视频".into()
            } else if account.desktop_cookie_sync_pending {
                "桌面 Cookie 已就绪，打开账号后完成导入".into()
            } else if account.last_known_logged_in {
                "上次已由豆包服务端确认登录，使用前会再次验证".into()
            } else if cached_verified {
                "豆包服务端未接受当前会话".into()
            } else {
                "尚未向平台服务端验证登录状态".into()
            },
            last_error: (!account.last_error.is_empty()).then(|| account.last_error.clone()),
            consecutive_failures: account.consecutive_failures,
            desktop_profile_dir: account.desktop_profile_dir.clone(),
            desktop_cookie_sync_pending: account.desktop_cookie_sync_pending,
            last_cookie_sync_at: (account.last_cookie_sync_at > 0)
                .then_some(account.last_cookie_sync_at),
        });
    };
    let current_url = window.url().ok().map(|url| url.to_string());
    let cookie_url = Url::parse(platform.home_url).map_err(|error| error.to_string())?;
    let cookies = tokio::task::spawn_blocking(move || window.cookies_for_url(cookie_url))
        .await
        .map_err(|error| format!("网页登录状态检查任务失败: {error}"))?
        .map_err(|error| format!("无法读取网页登录状态: {error}"))?;
    let (logged_in, status_verified, validation_detail) = if account.platform_id == "doubao" {
        let cookie_header = cookies
            .iter()
            .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
            .collect::<Vec<_>>()
            .join("; ");
        let check = validate_doubao_cookie_header(cookie_header).await;
        (check.logged_in, check.verified, check.detail)
    } else {
        let logged_in = cookies.iter().any(|cookie| {
            let name = cookie.name().to_ascii_lowercase();
            !cookie.value().trim().is_empty()
                && (name.contains("session")
                    || name.contains("token")
                    || name.contains("auth")
                    || name.contains("login"))
        });
        (logged_in, true, None)
    };

    Ok(DoubaoWebAccountState {
        id: account.id.clone(),
        name: account.name.clone(),
        platform_id: account.platform_id.clone(),
        enabled: account.enabled,
        busy,
        window_open: true,
        logged_in,
        status_verified,
        current_url,
        message: if !account.enabled {
            "已停用，不参与自动故障切换".into()
        } else if busy {
            "正在生成视频".into()
        } else if logged_in {
            format!("{}网页登录状态可用", platform.name)
        } else {
            validation_detail.unwrap_or_else(|| {
                if status_verified {
                    format!("请在专用窗口中完成{}登录或扫码确认", platform.name)
                } else {
                    format!("暂时无法向{}服务端确认登录状态", platform.name)
                }
            })
        },
        last_error: (!account.last_error.is_empty()).then(|| account.last_error.clone()),
        consecutive_failures: account.consecutive_failures,
        desktop_profile_dir: account.desktop_profile_dir.clone(),
        desktop_cookie_sync_pending: account.desktop_cookie_sync_pending,
        last_cookie_sync_at: (account.last_cookie_sync_at > 0)
            .then_some(account.last_cookie_sync_at),
    })
}

pub(crate) fn update_last_known_login(
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
            if account.platform_id == "doubao" {
                account.last_login_verified_at = unix_timestamp();
                account.login_validation_version = DOUBAO_LOGIN_VALIDATION_VERSION;
            }
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
        if state.status_verified
            && (state.logged_in != account.last_known_logged_in
                || (account.platform_id == "doubao"
                    && account.login_validation_version < DOUBAO_LOGIN_VALIDATION_VERSION))
        {
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

fn portable_cookies_from_runtime(
    cookies: Vec<tauri::webview::Cookie<'static>>,
) -> Vec<PortableDoubaoCookie> {
    cookies
        .into_iter()
        .filter(|cookie| !cookie.name().is_empty() && !cookie.value().is_empty())
        .map(|cookie| PortableDoubaoCookie {
            domain: cookie.domain().unwrap_or(".doubao.com").to_string(),
            path: cookie.path().unwrap_or("/").to_string(),
            name: cookie.name().to_string(),
            value: cookie.value().to_string(),
            expires_unix: cookie
                .expires_datetime()
                .map(|value| value.unix_timestamp()),
            secure: cookie.secure().unwrap_or(true),
            http_only: cookie.http_only().unwrap_or(false),
            same_site: match cookie.same_site() {
                Some(SameSite::None) => Some("none".into()),
                Some(SameSite::Lax) => Some("lax".into()),
                Some(SameSite::Strict) => Some("strict".into()),
                None => None,
            },
        })
        .collect()
}

async fn export_account_cookies(
    app: &AppHandle,
    account: &DoubaoWebAccountRecord,
) -> Result<Vec<PortableDoubaoCookie>, String> {
    let creator_label = format!("cle-creator-account-{}", account.id);
    let live_view = app
        .get_webview(&creator_label)
        .or_else(|| app.get_webview(&account_window_label(account)));
    if let Some(view) = live_view {
        let url = Url::parse("https://www.doubao.com/").map_err(|error| error.to_string())?;
        let cookies = tokio::task::spawn_blocking(move || view.cookies_for_url(url))
            .await
            .map_err(|error| format!("读取运行中的豆包凭证任务失败: {error}"))?
            .map_err(|error| format!("读取运行中的豆包凭证失败: {error}"))?;
        let cookies = portable_cookies_from_runtime(cookies);
        if !cookies.is_empty() {
            return Ok(cookies);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(profile_dir) = account.desktop_profile_dir.as_deref() {
            if let Ok(root) = doubao_desktop_user_data_dir() {
                if let Ok(cookies) = read_desktop_cookies(&root, profile_dir) {
                    return Ok(cookies.into_iter().map(Into::into).collect());
                }
            }
        }
        let root = browser_data_dir(app, account)?.join("EBWebView");
        if root.join("Local State").is_file() {
            if let Ok(cookies) = read_desktop_cookies(&root, "Default") {
                return Ok(cookies.into_iter().map(Into::into).collect());
            }
        }
    }

    if let Some(portable) = read_portable_account_file(app, &account.id)? {
        return Ok(portable.cookies);
    }
    Err("没有可导出的有效登录 Cookie；请先在工作台打开并确认该账号已登录".into())
}

pub async fn export_credentials(
    app: AppHandle,
    account_ids: Option<Vec<String>>,
) -> Result<DoubaoCredentialExportResult, String> {
    let store = load_store(&app)?;
    let selected: HashSet<String> = account_ids.unwrap_or_default().into_iter().collect();
    let accounts = store
        .accounts
        .into_iter()
        .filter(|account| {
            account.platform_id == "doubao"
                && (selected.is_empty() || selected.contains(&account.id))
        })
        .collect::<Vec<_>>();
    if accounts.is_empty() {
        return Err("没有可导出的豆包账号".into());
    }
    let mut exported = Vec::new();
    let mut skipped_accounts = Vec::new();
    for account in accounts {
        match export_account_cookies(&app, &account).await {
            Ok(mut cookies) => {
                let mut portable = PortableDoubaoAccount {
                    name: account.name,
                    source_account_id: Some(account.id),
                    cookies: std::mem::take(&mut cookies),
                };
                if let Err(error) = validate_portable_account(&mut portable) {
                    skipped_accounts.push(format!("{}：{error}", portable.name));
                } else {
                    exported.push(portable);
                }
            }
            Err(error) => skipped_accounts.push(format!("{}：{error}", account.name)),
        }
    }
    if exported.is_empty() {
        return Err(format!(
            "没有成功导出任何豆包账号：{}",
            skipped_accounts.join("；")
        ));
    }
    let cookie_count = exported.iter().map(|account| account.cookies.len()).sum();
    let file = PortableDoubaoCredentialFile {
        format: PORTABLE_CREDENTIAL_FORMAT.into(),
        version: PORTABLE_CREDENTIAL_VERSION,
        exported_at: unix_timestamp(),
        accounts: exported,
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|error| format!("生成豆包凭证文件失败: {error}"))?;
    Ok(DoubaoCredentialExportResult {
        account_count: file.accounts.len(),
        cookie_count,
        json,
        skipped_accounts,
    })
}

pub async fn import_credentials(
    app: AppHandle,
    json: String,
) -> Result<DoubaoCredentialImportResult, String> {
    if json.len() > MAX_PORTABLE_CREDENTIAL_BYTES {
        return Err("豆包凭证文件超过 8 MiB 限制".into());
    }
    let mut file: PortableDoubaoCredentialFile =
        serde_json::from_str(&json).map_err(|error| format!("豆包凭证 JSON 格式错误: {error}"))?;
    if file.format != PORTABLE_CREDENTIAL_FORMAT || file.version != PORTABLE_CREDENTIAL_VERSION {
        return Err("不是受支持的 C.le 豆包凭证文件（需要 cle-doubao-credential v1）".into());
    }
    if file.accounts.is_empty() || file.accounts.len() > 50 {
        return Err("豆包凭证中的账号数量必须为 1 到 50".into());
    }
    for account in &mut file.accounts {
        validate_portable_account(account)?;
    }
    let existing_count = load_store(&app)?.accounts.len();
    if existing_count + file.accounts.len() > 50 {
        return Err(format!(
            "导入后网页创作账号将超过 50 个（当前 {existing_count} 个，待导入 {} 个）",
            file.accounts.len()
        ));
    }

    let prepared = file
        .accounts
        .into_iter()
        .map(|account| (uuid::Uuid::new_v4().simple().to_string(), account))
        .collect::<Vec<_>>();
    let mut written_paths = Vec::new();
    for (account_id, account) in &prepared {
        if let Err(error) = write_portable_account_file(&app, account_id, account) {
            for path in written_paths {
                let _ = std::fs::remove_file(path);
            }
            return Err(error);
        }
        written_paths.push(portable_credential_path(&app, account_id)?);
    }
    let imported_account_ids = prepared
        .iter()
        .map(|(account_id, _)| account_id.clone())
        .collect::<Vec<_>>();
    let cookie_count = prepared
        .iter()
        .map(|(_, account)| account.cookies.len())
        .sum();
    if let Err(error) = update_store(&app, |store| {
        for (account_id, portable) in &prepared {
            store.accounts.push(DoubaoWebAccountRecord {
                id: account_id.clone(),
                name: portable.name.clone(),
                platform_id: "doubao".into(),
                enabled: true,
                last_known_logged_in: false,
                last_error: String::new(),
                consecutive_failures: 0,
                last_used_at: 0,
                desktop_profile_dir: None,
                desktop_cookie_sync_pending: true,
                last_cookie_sync_at: 0,
                last_login_verified_at: 0,
                login_validation_version: 0,
            });
        }
        Ok(())
    }) {
        for path in written_paths {
            let _ = std::fs::remove_file(path);
        }
        return Err(error);
    }
    let state = build_state(&app, imported_account_ids.first().cloned()).await?;
    Ok(DoubaoCredentialImportResult {
        message: format!(
            "已导入 {} 个豆包账号和 {cookie_count} 条 Cookie；首次打开账号时会写入独立工作台并向豆包验证",
            imported_account_ids.len()
        ),
        state,
        imported_account_ids,
        cookie_count,
    })
}

pub async fn get_state(
    app: AppHandle,
    selected_account_id: Option<String>,
) -> Result<DoubaoWebState, String> {
    // Import newly discovered desktop profiles automatically. The potentially
    // locked Cookie database itself is deliberately not opened here.
    reconcile_desktop_profile_records(&app)?;
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
            desktop_profile_dir: None,
            desktop_cookie_sync_pending: false,
            last_cookie_sync_at: 0,
            last_login_verified_at: 0,
            login_validation_version: 0,
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
    if let Ok(path) = portable_credential_path(&app, &removed.id) {
        let _ = std::fs::remove_file(path);
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
    )
    .await?
    {
        // Compatibility cleanup for accounts that were last opened by an older
        // release in a top-level window. New unified-workspace accounts never
        // create that extra window.
        if let Some(window) = app.get_webview_window(&account_window_label(&account)) {
            let url = Url::parse(home_url).map_err(|error| error.to_string())?;
            tokio::task::spawn_blocking(move || {
                window
                    .clear_all_browsing_data()
                    .map_err(|error| format!("清理网页登录状态失败: {error}"))?;
                window.navigate(url).map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| format!("清理网页登录状态任务失败: {error}"))??;
        } else {
            let profile_dir = browser_data_dir(&app, &account)?;
            if profile_dir.exists() {
                std::fs::remove_dir_all(&profile_dir)
                    .map_err(|error| format!("清理网页登录数据失败: {error}"))?;
            }
        }
    }
    update_last_known_login(&app, &account_id, false)?;
    // Explicit logout must also remove the retained portable bootstrap.
    // Otherwise reopening the account would silently restore the session that
    // the user just asked to clear.
    if let Ok(path) = portable_credential_path(&app, &account_id) {
        let _ = std::fs::remove_file(path);
    }
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
    fn desktop_profile_names_cannot_escape_doubao_user_data() {
        assert!(valid_desktop_profile_dir("Default"));
        assert!(valid_desktop_profile_dir("Profile 3"));
        assert!(valid_desktop_profile_dir("Profile 14"));
        assert!(!valid_desktop_profile_dir("Profile "));
        assert!(!valid_desktop_profile_dir("Profile ../Default"));
        assert!(!valid_desktop_profile_dir("../Default"));
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

    #[test]
    fn doubao_account_response_requires_a_real_identity() {
        let expired = serde_json::json!({
            "message": "error",
            "data": { "error_code": 13 }
        });
        assert!(!doubao_account_response_authenticated(&expired));
        assert_eq!(response_error_code(&expired), Some(13));

        let authenticated = serde_json::json!({
            "message": "success",
            "data": { "user_id_str": "redacted" }
        });
        assert!(doubao_account_response_authenticated(&authenticated));

        let ambiguous = serde_json::json!({
            "message": "success",
            "data": { "error_code": 0 }
        });
        assert!(!doubao_account_response_authenticated(&ambiguous));
    }

    #[test]
    fn account_info_url_keeps_cookie_safe_trailing_slash() {
        let parsed = Url::parse(DOUBAO_ACCOUNT_INFO_URL).unwrap();
        assert_eq!(parsed.path(), "/passport/account/info/v2/");
        assert_eq!(
            parsed
                .query_pairs()
                .find(|(key, _)| key == "account_sdk_source")
                .map(|(_, value)| value.into_owned()),
            Some("web".into())
        );
    }

    #[test]
    fn portable_credentials_only_accept_doubao_cookie_domains() {
        let mut allowed = PortableDoubaoCookie {
            domain: ".doubao.com".into(),
            path: "/".into(),
            name: "sessionid".into(),
            value: "redacted-test-value".into(),
            expires_unix: None,
            secure: true,
            http_only: true,
            same_site: Some("None".into()),
        };
        normalize_portable_cookie(&mut allowed).unwrap();
        assert_eq!(allowed.same_site.as_deref(), Some("none"));

        let mut rejected = allowed.clone();
        rejected.domain = "example.com".into();
        assert!(normalize_portable_cookie(&mut rejected).is_err());
    }

    #[test]
    fn portable_account_deduplicates_cookie_keys() {
        let cookie = PortableDoubaoCookie {
            domain: ".doubao.com".into(),
            path: "/".into(),
            name: "sessionid".into(),
            value: "redacted-test-value".into(),
            expires_unix: None,
            secure: true,
            http_only: true,
            same_site: Some("lax".into()),
        };
        let mut account = PortableDoubaoAccount {
            name: "  迁移账号  ".into(),
            source_account_id: None,
            cookies: vec![cookie.clone(), cookie],
        };
        validate_portable_account(&mut account).unwrap();
        assert_eq!(account.name, "迁移账号");
        assert_eq!(account.cookies.len(), 1);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn locked_profile_can_use_doubao_multi_account_session() {
        let local_state = serde_json::json!({
            "profile": {
                "info_cache": {
                    "Profile 15": { "saman": { "user_id": "2803105319361600" } }
                }
            },
            "saman": {
                "local_storage_app_for_web": {
                    "enterprise": r#"{"x-tt-multi-sids":"other%3Aold%7C2803105319361600%3Alive-session"}"#
                }
            }
        });
        let (sid, encoded) =
            multi_sid_from_local_state(&local_state, "Profile 15").expect("multi sid");
        assert_eq!(sid, "live-session");
        assert!(encoded.contains("2803105319361600%3Alive-session"));
        assert!(multi_sid_from_local_state(&local_state, "Profile 99").is_err());
    }
}
