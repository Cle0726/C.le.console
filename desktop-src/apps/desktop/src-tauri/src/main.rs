mod app_paths;
mod multi_proxy;
mod sidecar;

mod commands {
    pub mod auth_helper;
    pub mod config;
    pub mod gateway;
    pub mod multi_proxy;
}

use multi_proxy::MultiProxyManager;
use sidecar::SidecarManager;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(SidecarManager::default())
        .manage(MultiProxyManager::default())
        .setup(|app| {
            match commands::config::load_gateway_config() {
                Ok(config) if config.enabled => {
                    let sidecar = app.state::<SidecarManager>();
                    if let Err(error) = sidecar::start_sidecar(&sidecar, &config)
                        .and_then(|_| sidecar::wait_until_ready(&config))
                    {
                        eprintln!("failed to auto-start sidecar: {error}");
                    }
                }
                Ok(_) => {}
                Err(error) => eprintln!("failed to load gateway config during setup: {error}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth_helper::get_auth_status,
            commands::auth_helper::launch_claude_login,
            commands::config::import_session_keys,
            commands::config::save_gateway_config,
            commands::gateway::get_gateway_snapshot,
            commands::gateway::list_gateway_models,
            commands::gateway::start_gateway,
            commands::gateway::stop_gateway,
            commands::gateway::test_gateway_chat,
            commands::multi_proxy::get_multi_proxy_snapshot,
            commands::multi_proxy::get_multi_proxy_status,
            commands::multi_proxy::reload_multi_proxy,
            commands::multi_proxy::reset_multi_proxy_runtime,
            commands::multi_proxy::save_multi_proxy_config,
            commands::multi_proxy::start_multi_proxy,
            commands::multi_proxy::stop_multi_proxy,
            commands::multi_proxy::test_multi_proxy_chat,
            commands::multi_proxy::test_multi_proxy_image,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri app");
}
