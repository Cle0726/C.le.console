use crate::modules::doubao_web::{self, DoubaoWebState, DoubaoWebVideoRequest};
use crate::modules::jimeng_api::{self, JimengApiConfig, JimengApiState, JimengMediaRequest};
use crate::modules::web_creator_workspace::{
    self, WebCreatorAsset, WebCreatorBounds, WebCreatorDownloadResult, WebCreatorWorkspaceState,
};
use serde_json::Value;
use tauri::AppHandle;

#[tauri::command]
pub async fn jimeng_api_get_state() -> Result<JimengApiState, String> {
    jimeng_api::get_state().await
}

#[tauri::command]
pub async fn jimeng_api_save_config(config: JimengApiConfig) -> Result<JimengApiState, String> {
    jimeng_api::save_config(config).await
}

#[tauri::command]
pub async fn jimeng_api_set_enabled(enabled: bool) -> Result<JimengApiState, String> {
    jimeng_api::set_enabled(enabled).await
}

#[tauri::command]
pub async fn jimeng_api_account_action(
    action: String,
    account_id: Option<String>,
) -> Result<Value, String> {
    jimeng_api::account_action(&action, account_id).await
}

#[tauri::command]
pub async fn jimeng_api_generate_image(request: JimengMediaRequest) -> Result<Value, String> {
    jimeng_api::media_request("/v1/images/generations", request).await
}

#[tauri::command]
pub async fn jimeng_api_compose_image(request: JimengMediaRequest) -> Result<Value, String> {
    jimeng_api::media_request("/v1/images/compositions", request).await
}

#[tauri::command]
pub async fn jimeng_api_generate_video(request: JimengMediaRequest) -> Result<Value, String> {
    jimeng_api::media_request("/v1/videos/generations", request).await
}

#[tauri::command]
pub async fn jimeng_api_diagnose_and_repair() -> Result<Value, String> {
    jimeng_api::diagnose_and_repair().await
}

#[tauri::command]
pub async fn jimeng_api_start_device_flow(
    account_id: String,
    account_name: String,
    region: String,
) -> Result<Value, String> {
    jimeng_api::start_device_flow(account_id, account_name, region).await
}

#[tauri::command]
pub async fn jimeng_api_poll_device_flow(flow_id: String) -> Result<Value, String> {
    jimeng_api::poll_device_flow(&flow_id).await
}

#[tauri::command]
pub async fn jimeng_api_cancel_device_flow(flow_id: String) -> Result<(), String> {
    jimeng_api::cancel_device_flow(&flow_id)
}

#[tauri::command]
pub async fn doubao_web_get_state(
    app: AppHandle,
    selected_account_id: Option<String>,
) -> Result<DoubaoWebState, String> {
    doubao_web::get_state(app, selected_account_id).await
}

#[tauri::command]
pub async fn doubao_web_add_account(
    app: AppHandle,
    platform_id: Option<String>,
    name: Option<String>,
) -> Result<DoubaoWebState, String> {
    doubao_web::add_account(app, platform_id, name).await
}

#[tauri::command]
pub async fn doubao_web_set_account_enabled(
    app: AppHandle,
    account_id: String,
    enabled: bool,
) -> Result<DoubaoWebState, String> {
    doubao_web::set_account_enabled(app, account_id, enabled).await
}

#[tauri::command]
pub async fn doubao_web_rename_account(
    app: AppHandle,
    account_id: String,
    name: String,
) -> Result<DoubaoWebState, String> {
    doubao_web::rename_account(app, account_id, name).await
}

#[tauri::command]
pub async fn doubao_web_remove_account(
    app: AppHandle,
    account_id: String,
) -> Result<DoubaoWebState, String> {
    doubao_web::remove_account(app, account_id).await
}

#[tauri::command]
pub async fn doubao_web_open_login(
    app: AppHandle,
    account_id: String,
) -> Result<DoubaoWebState, String> {
    doubao_web::open_login(app, account_id).await
}

#[tauri::command]
pub async fn doubao_web_logout(
    app: AppHandle,
    account_id: String,
) -> Result<DoubaoWebState, String> {
    doubao_web::logout(app, account_id).await
}

#[tauri::command]
pub async fn doubao_web_generate_video(
    app: AppHandle,
    request: DoubaoWebVideoRequest,
) -> Result<Value, String> {
    doubao_web::generate_video(app, request).await
}

#[tauri::command]
pub fn web_creator_open_window(app: AppHandle) -> Result<(), String> {
    web_creator_workspace::show_workspace_window(&app)
}

#[tauri::command]
pub async fn web_creator_open_account(
    app: AppHandle,
    account_id: String,
    bounds: Option<WebCreatorBounds>,
) -> Result<WebCreatorWorkspaceState, String> {
    web_creator_workspace::open_account(app, account_id, bounds).await
}

#[tauri::command]
pub fn web_creator_set_bounds(
    app: AppHandle,
    bounds: WebCreatorBounds,
) -> Result<WebCreatorWorkspaceState, String> {
    web_creator_workspace::set_bounds(&app, bounds)
}

#[tauri::command]
pub fn web_creator_hide(app: AppHandle) -> Result<WebCreatorWorkspaceState, String> {
    web_creator_workspace::hide(&app)
}

#[tauri::command]
pub fn web_creator_navigate(
    app: AppHandle,
    action: String,
) -> Result<WebCreatorWorkspaceState, String> {
    web_creator_workspace::navigate(&app, action)
}

#[tauri::command]
pub fn web_creator_navigate_to(
    app: AppHandle,
    url: String,
) -> Result<WebCreatorWorkspaceState, String> {
    web_creator_workspace::navigate_to(&app, url)
}

#[tauri::command]
pub fn web_creator_get_state(app: AppHandle) -> WebCreatorWorkspaceState {
    web_creator_workspace::workspace_state(&app)
}

#[tauri::command]
pub async fn web_creator_collect_assets(
    app: AppHandle,
    account_id: Option<String>,
) -> Result<Vec<WebCreatorAsset>, String> {
    web_creator_workspace::collect_assets(app, account_id).await
}

#[tauri::command]
pub fn web_creator_clear_assets(app: AppHandle, account_id: Option<String>) -> Result<(), String> {
    web_creator_workspace::clear_assets(&app, account_id)
}

#[tauri::command]
pub async fn web_creator_download_asset(
    app: AppHandle,
    account_id: Option<String>,
    asset: WebCreatorAsset,
) -> Result<WebCreatorDownloadResult, String> {
    web_creator_workspace::download_asset(app, account_id, asset).await
}
