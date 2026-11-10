//! Process-exit cleanup for sidecars that outlive a closed window.
//!
//! Hiding a window parks its webview and intentionally leaves the API running.
//! `RunEvent::Exit` is the real quit path and must stop those processes.

use std::time::Duration;

pub fn shutdown_for_exit() {
    crate::modules::agent_provider_bridge::stop();
    crate::modules::subscription_proxy::shutdown_for_exit();

    let (tx, rx) = std::sync::mpsc::channel();
    let started = std::thread::Builder::new()
        .name("cle-exit-shutdown".to_string())
        .spawn(move || {
            let result = std::panic::catch_unwind(|| {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(async {
                        crate::modules::multi_model_api::shutdown().await;
                        crate::modules::jimeng_api::shutdown_for_exit().await;
                        crate::modules::codex_local_access::shutdown_local_access_gateway_for_app_exit()
                            .await;
                    });
                }
            });
            if result.is_err() {
                crate::modules::logger::log_warn("[Exit] sidecar 关闭过程中断");
            }
            let _ = tx.send(());
        });
    if started.is_err() {
        crate::modules::logger::log_warn("[Exit] 无法启动 sidecar 关闭线程");
        return;
    }
    if rx.recv_timeout(Duration::from_secs(8)).is_err() {
        crate::modules::logger::log_warn("[Exit] 等待 sidecar 关闭超时，进程继续退出");
    }
}
