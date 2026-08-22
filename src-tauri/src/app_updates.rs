use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_updater::UpdaterExt;

const UPDATE_ENDPOINT: &str =
    "https://github.com/Cle0726/C.le.console/releases/latest/download/latest.json";

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

    let updater = app
        .updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| format!("配置更新地址失败: {error}"))?
        .timeout(Duration::from_secs(45))
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
