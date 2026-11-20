//! External OAuth browser with a per-process proxy, never a system proxy change.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use url::Url;

fn browser_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(windows)]
    for (variable, relative) in [
        ("PROGRAMFILES", "Google\\Chrome\\Application\\chrome.exe"),
        ("PROGRAMFILES(X86)", "Microsoft\\Edge\\Application\\msedge.exe"),
        ("PROGRAMFILES", "Microsoft\\Edge\\Application\\msedge.exe"),
        ("LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"),
        ("LOCALAPPDATA", "Microsoft\\Edge\\Application\\msedge.exe"),
    ] {
        if let Some(root) = std::env::var_os(variable) { paths.push(PathBuf::from(root).join(relative)); }
    }
    #[cfg(target_os = "macos")]
    for path in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"] { paths.push(PathBuf::from(path)); }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in if cfg!(windows) { vec!["msedge.exe", "chrome.exe"] } else { vec!["google-chrome", "chromium", "chromium-browser", "microsoft-edge"] } {
                paths.push(dir.join(name));
            }
        }
    }
    paths
}

fn validate_auth_url(raw: &str) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|_| "授权链接格式无效".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("授权链接必须是没有内嵌凭据的 HTTPS 地址".into());
    }
    Ok(())
}

fn browser_args(proxy: &str, profile: &Path, url: &str) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        format!("--proxy-server={proxy}"),
        "--proxy-bypass-list=localhost;127.0.0.1;[::1]".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--new-window".into(),
        url.into(),
    ]
}

/// Returns false when no subscription is enabled so the caller can use the
/// ordinary system browser. With a subscription, failure is explicit and never
/// silently sends the OAuth session outside the selected route.
#[tauri::command]
pub fn subscription_proxy_open_auth_url(url: String) -> Result<bool, String> {
    open_with_subscription(&url)
}

/// Backend OAuth flows (Antigravity, Claude) use this before falling back to
/// the system browser, so a selected subscription also covers their sign-in.
pub fn open_with_subscription(url: &str) -> Result<bool, String> {
    let url = url.to_string();
    let (proxy, port) = if let Some(proxy) = crate::modules::subscription_proxy::enabled_local_proxy() {
        let parsed = Url::parse(&proxy).map_err(|_| "订阅代理地址无效".to_string())?;
        let port = parsed.port().ok_or_else(|| "订阅代理端口无效".to_string())?;
        std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            std::time::Duration::from_millis(500),
        ).map_err(|_| "订阅节点尚未就绪，请先在订阅节点页面重新选择节点".to_string())?;
        (proxy, port)
    } else if let Some((proxy, port)) = manual_global_proxy(&crate::modules::config::get_user_config()) {
        // 没有订阅节点但设置里开了全局代理：授权浏览器同样走这条代理。
        (proxy, port)
    } else {
        return Ok(false);
    };
    validate_auth_url(&url)?;
    let browser = browser_candidates().into_iter().find(|path| path.is_file())
        .ok_or_else(|| "未找到 Chrome、Edge 或 Chromium；请先安装其中一个浏览器以完成授权".to_string())?;
    let profile = crate::modules::config::get_data_dir()?.join("oauth-browser").join(port.to_string());
    std::fs::create_dir_all(&profile).map_err(|error| format!("创建授权浏览器目录失败: {error}"))?;
    let mut command = Command::new(browser);
    command.args(browser_args(&proxy, &profile, &url)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|error| format!("打开授权浏览器失败: {error}"))?;
    Ok(true)
}

/// 设置里开启的全局代理，转换成 Chrome --proxy-server 能识别的形式。
fn manual_global_proxy(config: &crate::modules::config::UserConfig) -> Option<(String, u16)> {
    if !config.global_proxy_enabled {
        return None;
    }
    let raw = config.global_proxy_url.trim();
    if raw.is_empty() {
        return None;
    }
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let parsed = Url::parse(&with_scheme).ok()?;
    let scheme = match parsed.scheme() {
        "http" | "https" => parsed.scheme().to_string(),
        "socks5" | "socks5h" => "socks5".to_string(),
        "socks4" | "socks4a" => "socks4".to_string(),
        _ => return None,
    };
    let host = parsed.host_str()?;
    let port = parsed.port_or_known_default()?;
    Some((format!("{scheme}://{host}:{port}"), port))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_auth_urls() {
        assert!(validate_auth_url("https://accounts.google.com/o/oauth2/auth?state=x").is_ok());
        assert!(validate_auth_url("http://example.com/").is_err());
        assert!(validate_auth_url("https://user:pass@example.com/").is_err());
    }
    #[test]
    fn manual_global_proxy_is_used_only_when_enabled() {
        let mut config = crate::modules::config::UserConfig::default();
        config.global_proxy_url = "127.0.0.1:7890".into();
        assert_eq!(manual_global_proxy(&config), None);
        config.global_proxy_enabled = true;
        assert_eq!(manual_global_proxy(&config), Some(("http://127.0.0.1:7890".into(), 7890)));
        config.global_proxy_url = "socks5h://127.0.0.1:7891".into();
        assert_eq!(manual_global_proxy(&config), Some(("socks5://127.0.0.1:7891".into(), 7891)));
        config.global_proxy_url = "  ".into();
        assert_eq!(manual_global_proxy(&config), None);
    }
    #[test]
    fn proxy_browser_isolated_and_local_callbacks_bypass_proxy() {
        let args = browser_args("http://127.0.0.1:17890", Path::new("profile"), "https://example.com");
        assert!(args.iter().any(|v| v == "--proxy-server=http://127.0.0.1:17890"));
        assert!(args.iter().any(|v| v.contains("localhost;127.0.0.1;[::1]")));
        assert!(args.iter().any(|v| v.starts_with("--user-data-dir=")));
    }
}
