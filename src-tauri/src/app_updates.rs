use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::UpdaterExt;

const UPDATE_ENDPOINT: &str =
    "https://github.com/Cle0726/C.le.console/releases/latest/download/latest.json";
const LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/Cle0726/C.le.console/releases/latest";

#[derive(Debug, Deserialize, Serialize)]
pub struct GitHubRelease {
    tag_name: Option<String>,
    name: Option<String>,
    body: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    published_at: Option<String>,
}

fn release_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("C-le-console-updater/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20));
    if let Some(proxy) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "更新代理地址无效")?);
    }
    builder.build().map_err(|error| format!("创建更新客户端失败: {error}"))
}

#[tauri::command]
pub async fn get_latest_app_release() -> Result<GitHubRelease, String> {
    // WebView fetch does not inherit the workbench's per-process proxy on
    // every platform. Use the same explicit route as the OAuth clients.
    let subscription = crate::modules::subscription_proxy::enabled_local_proxy();
    let response = release_client(subscription.as_deref())?
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send().await
        .map_err(|error| format!("无法连接更新服务器: {}", error.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("更新服务器返回 HTTP {}", response.status().as_u16()));
    }
    response.json::<GitHubRelease>().await
        .map_err(|error| format!("解析更新信息失败: {}", error.without_url()))
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

fn updater_public_key() -> Result<&'static str, String> {
    option_env!("TAURI_UPDATER_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "自动更新未配置公钥。请使用带 TAURI_UPDATER_PUBLIC_KEY 构建的正式版本。".to_string()
        })
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let public_key = updater_public_key()?;
    let endpoint = UPDATE_ENDPOINT
        .parse()
        .map_err(|error| format!("无效的更新地址: {error}"))?;

    let mut builder = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| format!("配置更新地址失败: {error}"))?
        .timeout(Duration::from_secs(45));
    if let Some(proxy) = crate::modules::subscription_proxy::enabled_local_proxy() {
        builder = builder.proxy(proxy.parse().map_err(|_| "更新代理地址无效")?);
    }
    let updater = builder
        .build()
        .map_err(|error| format!("初始化更新器失败: {error}"))?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("检查更新失败: {error}"))?
    else {
        return Err("当前已是最新版本，或发布包尚未准备好。".to_string());
    };

    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| format!("下载或安装更新失败: {error}"))?;

    // Windows exits the application automatically while installing. If control
    // returns on another desktop platform, restart into the newly installed build.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn update_check_uses_the_explicit_workbench_proxy() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0u8; 1];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert!(String::from_utf8_lossy(&request).starts_with("GET http://updates.invalid/latest HTTP/1.1"));
            let body = br#"{"tag_name":"v9.9.9","draft":false,"prerelease":false}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(body).unwrap();
        });
        let proxy = format!("http://{address}");
        let release = release_client(Some(&proxy)).unwrap()
            .get("http://updates.invalid/latest").send().await.unwrap()
            .json::<GitHubRelease>().await.unwrap();
        assert_eq!(release.tag_name.as_deref(), Some("v9.9.9"));
        server.join().unwrap();
    }
}
