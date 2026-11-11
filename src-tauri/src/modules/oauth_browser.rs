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
    let Some(proxy) = crate::modules::subscription_proxy::enabled_local_proxy() else { return Ok(false); };
    validate_auth_url(&url)?;
    let parsed = Url::parse(&proxy).map_err(|_| "订阅代理地址无效".to_string())?;
    let port = parsed.port().ok_or_else(|| "订阅代理端口无效".to_string())?;
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(500),
    ).map_err(|_| "订阅节点尚未就绪，请先在订阅节点页面重新选择节点".to_string())?;
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
    fn proxy_browser_isolated_and_local_callbacks_bypass_proxy() {
        let args = browser_args("http://127.0.0.1:17890", Path::new("profile"), "https://example.com");
        assert!(args.iter().any(|v| v == "--proxy-server=http://127.0.0.1:17890"));
        assert!(args.iter().any(|v| v.contains("localhost;127.0.0.1;[::1]")));
        assert!(args.iter().any(|v| v.starts_with("--user-data-dir=")));
    }
}
