//! Host custom-protocol OAuth in an isolated webview, not the system browser.
//! Remote login pages have no C.le IPC capabilities. Never log callback URLs.
use super::agent_provider_bridge as bridge;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::{
    webview::NewWindowResponse, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

#[derive(Clone)]
struct Login {
    state: String,
    provider: String,
    url: Url,
    callback: Option<Url>,
    label: String,
    submitting: Arc<AtomicBool>,
}
static LOGINS: OnceLock<Mutex<HashMap<String, Login>>> = OnceLock::new();
fn logins() -> &'static Mutex<HashMap<String, Login>> {
    LOGINS.get_or_init(Default::default)
}
fn valid_state(state: &str) -> bool {
    !state.is_empty()
        && state.len() <= 180
        && state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn validate_entry(provider: &str, url: &Url) -> Result<Option<Url>, String> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("授权页地址不安全，已停止打开".into());
    }
    match provider {
        "raccoon"
            if url.host_str() == Some("xiaohuanxiong.com") && url.path() == "/code/authorize" =>
        {
            Ok(None)
        }
        "trae"
            if matches!(
                url.host_str(),
                Some("www.trae.cn" | "api.trae.cn" | "api.trae.com.cn")
            ) && url.path() == "/authorization" =>
        {
            let callback = url
                .query_pairs()
                .find(|(key, _)| key == "auth_callback_url")
                .and_then(|(_, value)| Url::parse(&value).ok())
                .ok_or("Trae 缺少本机回调地址")?;
            if callback.scheme() != "http"
                || callback.host_str() != Some("127.0.0.1")
                || callback.port().is_none()
                || callback.path() != "/authorize"
                || callback.query().is_some()
                || !callback.username().is_empty()
                || callback.password().is_some()
                || callback.fragment().is_some()
            {
                return Err("Trae 本机回调地址无效".into());
            }
            Ok(Some(callback))
        }
        _ => Err("上游返回了未识别的官方授权页，请更新授权组件".into()),
    }
}
fn is_callback(login: &Login, url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return false;
    }
    if login.provider == "raccoon" {
        url.scheme() == "office-raccoon"
            && url.host_str() == Some("auth")
            && url.path() == "/callback"
            && url
                .query_pairs()
                .filter(|(key, _)| key == "state")
                .map(|(_, value)| value.into_owned())
                .collect::<Vec<_>>()
                == [login.state.clone()]
    } else {
        login.callback.as_ref().is_some_and(|expected| {
            url.scheme() == expected.scheme()
                && url.host_str() == expected.host_str()
                && url.port() == expected.port()
                && url.path() == expected.path()
        })
    }
}
fn allow_navigation(url: &Url) -> bool {
    url.scheme() == "https" || url.as_str() == "about:blank"
}
fn trae_region_error(status: u16, body: &str) -> Option<String> {
    (status == 403 && body.contains("当前区域不支持访问")).then(||
        "Trae 国内版官方授权站拒绝当前网络区域（HTTP 403：当前区域不支持访问）。请在官方支持的网络地区重试，或粘贴已有的国内版完整凭证；当前代理不支持国际版账号，不能直接换国际站链接。".into())
}
async fn check_trae_region(url: &Url) -> Result<(), String> {
    // This is an anonymous page request, never inference, token exchange or proxy-setting changes.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "授权页检查初始化失败")?;
    if let Ok(mut response) = client.get(url.clone()).send().await {
        if response.status().as_u16() == 403 {
            let mut bytes = Vec::new();
            while let Ok(Some(chunk)) = response.chunk().await {
                if bytes.len() + chunk.len() > 8192 {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            if let Some(error) = trae_region_error(403, &String::from_utf8_lossy(&bytes)) {
                return Err(error);
            }
        }
    }
    // A failed probe is not proof the user's browser cannot connect.
    Ok(())
}
fn capture(app: &AppHandle, login: &Login, url: &Url) -> bool {
    if !is_callback(login, url) {
        return false;
    }
    if login.submitting.swap(true, Ordering::AcqRel) {
        return true;
    }
    let app = app.clone();
    let login = login.clone();
    let callback_url = url.to_string();
    tauri::async_runtime::spawn(async move {
        match bridge::request(
            "POST".into(),
            "/api/session/login/callback".into(),
            Some(json!({"state": login.state, "callbackUrl": callback_url})),
        )
        .await
        {
            Ok(_) => {
                if let Some(window) = app.get_webview_window(&login.label) {
                    let _ = window.close();
                }
                // Polling the original task is authoritative; submitting a callback is not proof of login.
            }
            Err(error) => {
                login.submitting.store(false, Ordering::Release);
                let _ = app.emit(
                    "extension-login:status",
                    json!({"state": login.state, "error": error}),
                );
            }
        }
    });
    true
}
async fn open_window(app: AppHandle, login: Login) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(window) = app.get_webview_window(&login.label) {
            let _ = window.show();
            return window.set_focus().map_err(|_| "无法聚焦授权窗口".into());
        }
        let nav_app = app.clone();
        let nav_login = login.clone();
        let popup_app = app.clone();
        let popup_login = login.clone();
        let window =
            WebviewWindowBuilder::new(&app, &login.label, WebviewUrl::External(login.url.clone()))
                .title(if login.provider == "raccoon" {
                    "C.le. · 小浣熊官方登录"
                } else {
                    "C.le. · Trae 官方登录"
                })
                .inner_size(1000., 760.)
                .min_inner_size(700., 540.)
                .incognito(true)
                .on_navigation(move |url| {
                    !capture(&nav_app, &nav_login, url) && allow_navigation(url)
                })
                .on_new_window(move |url, _| {
                    if !capture(&popup_app, &popup_login, &url) && allow_navigation(&url) {
                        if let Some(window) = popup_app.get_webview_window(&popup_login.label) {
                            let _ = window.navigate(url);
                        }
                    }
                    NewWindowResponse::Deny
                })
                .build()
                .map_err(|_| "无法创建独立授权窗口，请重试".to_string())?;
        let close_app = app.clone();
        let close_login = login.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && !close_login.submitting.load(Ordering::Acquire)
            {
                let removed = logins()
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&close_login.state));
                if removed.is_some() {
                    let state = close_login.state.clone();
                    let app = close_app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = bridge::request(
                            "POST".into(),
                            "/api/session/login/cancel".into(),
                            Some(json!({"state": state})),
                        )
                        .await;
                        let _ = app.emit(
                            "extension-login:status",
                            json!({"state": state, "cancelled": true}),
                        );
                    });
                }
            }
        });
        Ok(())
    })
    .await
    .map_err(|_| "授权窗口创建任务失败".to_string())?
}

pub async fn start(
    app: AppHandle,
    provider: String,
    edition: String,
    name: String,
) -> Result<Value, String> {
    let mut result = bridge::request(
        "POST".into(),
        "/api/session/login/start".into(),
        Some(json!({"provider": provider, "edition": edition, "name": name})),
    )
    .await?;
    let state = result
        .get("state")
        .and_then(Value::as_str)
        .filter(|s| valid_state(s))
        .ok_or("授权任务 ID 无效")?
        .to_string();
    if !matches!(provider.as_str(), "raccoon" | "trae") {
        result["hosted"] = json!(false);
        return Ok(result);
    }
    let hosted = async {
        let url = result
            .get("authUrl")
            .and_then(Value::as_str)
            .and_then(|s| Url::parse(s).ok())
            .ok_or("授权页地址无效")?;
        let callback = validate_entry(&provider, &url)?;
        if provider == "trae" {
            check_trae_region(&url).await?;
        }
        if provider == "raccoon"
            && url
                .query_pairs()
                .find(|(key, _)| key == "state")
                .map(|(_, value)| value.into_owned())
                .as_deref()
                != Some(state.as_str())
        {
            return Err("小浣熊授权地址与登录任务不匹配，请重试".into());
        }
        let login = Login {
            state: state.clone(),
            provider,
            url,
            callback,
            label: format!("extension-login-{}", uuid::Uuid::new_v4()),
            submitting: Arc::new(AtomicBool::new(false)),
        };
        {
            let mut map = logins().lock().map_err(|_| "授权任务锁不可用")?;
            if map.len() >= 8 {
                return Err("授权窗口过多，请先关闭其他登录窗口".to_string());
            }
            map.insert(state.clone(), login.clone());
        }
        open_window(app.clone(), login).await
    }
    .await;
    if let Err(error) = hosted {
        let _ = finish(app, state, true).await;
        return Err(error);
    }
    result["hosted"] = json!(true);
    Ok(result)
}
pub async fn reopen(app: AppHandle, state: String) -> Result<(), String> {
    let login = logins()
        .lock()
        .map_err(|_| "授权任务锁不可用")?
        .get(&state)
        .cloned()
        .ok_or("授权窗口已关闭，请重新开始登录")?;
    open_window(app, login).await
}
pub async fn finish(app: AppHandle, state: String, cancel: bool) -> Result<(), String> {
    if !valid_state(&state) {
        return Err("授权任务 ID 无效".into());
    }
    let login = logins()
        .lock()
        .map_err(|_| "授权任务锁不可用")?
        .remove(&state);
    if let Some(login) = login {
        login.submitting.store(true, Ordering::Release);
        if let Some(window) = app.get_webview_window(&login.label) {
            let _ = window.close();
        }
    }
    if cancel {
        bridge::request(
            "POST".into(),
            "/api/session/login/cancel".into(),
            Some(json!({"state": state})),
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn login(provider: &str, state: &str, address: &str) -> Login {
        let url = Url::parse(address).unwrap();
        Login {
            state: state.into(),
            provider: provider.into(),
            callback: validate_entry(provider, &url).unwrap(),
            url,
            label: "fixture".into(),
            submitting: Arc::new(AtomicBool::new(false)),
        }
    }
    #[test]
    fn raccoon_callback_is_bound_to_task() {
        let task = login(
            "raccoon",
            "fixture",
            "https://xiaohuanxiong.com/code/authorize?state=fixture",
        );
        assert!(is_callback(
            &task,
            &Url::parse("office-raccoon://auth/callback?code=test&state=fixture").unwrap()
        ));
        for url in [
            "office-raccoon://auth/callback?code=test&state=other",
            "office-raccoon://evil/callback?state=fixture",
            "office-raccoon://auth/callback?state=fixture&state=other",
        ] {
            assert!(!is_callback(&task, &Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn trae_callback_is_bound_to_original_port() {
        let task = login(
            "trae",
            "trae-1",
            "https://www.trae.cn/authorization?auth_callback_url=http://127.0.0.1:12345/authorize",
        );
        assert!(is_callback(
            &task,
            &Url::parse("http://127.0.0.1:12345/authorize?error=access_denied").unwrap()
        ));
        assert!(!is_callback(
            &task,
            &Url::parse("http://127.0.0.1:12346/authorize?authCode=test").unwrap()
        ));
        assert!(!is_callback(
            &task,
            &Url::parse("https://evil.example/authorize?authCode=test").unwrap()
        ));
    }
    #[test]
    fn untrusted_entry_and_external_protocols_are_rejected() {
        for url in [
            "http://xiaohuanxiong.com/code/authorize",
            "https://xiaohuanxiong.com.evil.example/code/authorize",
            "https://user@xiaohuanxiong.com/code/authorize",
        ] {
            assert!(validate_entry("raccoon", &Url::parse(url).unwrap()).is_err());
        }
        assert!(!allow_navigation(
            &Url::parse("file:///etc/passwd").unwrap()
        ));
        assert!(!allow_navigation(
            &Url::parse("http://127.0.0.1:9999/api/accounts").unwrap()
        ));
    }
    #[test]
    fn regional_restriction_is_not_misreported_as_a_callback_failure() {
        assert!(trae_region_error(403, "抱歉，您当前区域不支持访问")
            .unwrap()
            .contains("国际版"));
        assert!(trae_region_error(200, "fixture").is_none());
        assert!(trae_region_error(403, "captcha challenge").is_none());
    }
}
