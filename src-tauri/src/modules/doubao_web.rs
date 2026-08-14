//! Doubao web login and video generation bridge.
//!
//! The request shape and Samantha SSE flow are adapted from the Apache-2.0
//! project https://github.com/wangchuxiaoji-oss/doubao2api. C.le. deliberately
//! runs the request in its dedicated Tauri webview so the user's real Doubao
//! page session and the site's own request-signing hooks remain authoritative.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

const WINDOW_LABEL: &str = "doubao-web-login";
const DOUBAO_CHAT_URL: &str = "https://www.doubao.com/chat/";
const GENERATION_TIMEOUT: Duration = Duration::from_secs(390);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoWebState {
    pub window_open: bool,
    pub logged_in: bool,
    pub current_url: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoubaoWebVideoRequest {
    pub prompt: String,
    #[serde(default = "default_ratio")]
    pub ratio: String,
}

fn default_ratio() -> String {
    "16:9".into()
}

fn browser_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位豆包浏览器数据目录: {error}"))?
        .join("doubao-web-profile"))
}

fn ensure_window(app: &AppHandle, visible: bool) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if visible {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        return Ok(window);
    }

    let data_dir = browser_data_dir(app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("无法创建豆包浏览器数据目录: {error}"))?;
    let url = Url::parse(DOUBAO_CHAT_URL).map_err(|error| error.to_string())?;
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("豆包网页版登录")
        .inner_size(1180.0, 820.0)
        .min_inner_size(880.0, 640.0)
        .resizable(true)
        .visible(visible)
        .data_directory(data_dir)
        .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
        .build()
        .map_err(|error| format!("无法打开豆包网页版: {error}"))?;

    if visible {
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(window)
}

async fn window_state(window: WebviewWindow) -> Result<DoubaoWebState, String> {
    let current_url = window.url().ok().map(|url| url.to_string());
    let cookie_url = Url::parse("https://www.doubao.com/").map_err(|error| error.to_string())?;
    let cookies = tokio::task::spawn_blocking(move || window.cookies_for_url(cookie_url))
        .await
        .map_err(|error| format!("豆包登录状态检查任务失败: {error}"))?
        .map_err(|error| format!("无法读取豆包登录状态: {error}"))?;
    let logged_in = cookies.iter().any(|cookie| {
        matches!(cookie.name(), "sessionid" | "sessionid_ss") && !cookie.value().trim().is_empty()
    });

    Ok(DoubaoWebState {
        window_open: true,
        logged_in,
        current_url,
        message: if logged_in {
            "豆包网页版已登录，可以使用 Seedance 2.0 生成视频".into()
        } else {
            "请在专用窗口中完成豆包登录或扫码确认".into()
        },
    })
}

pub async fn open_login(app: AppHandle) -> Result<DoubaoWebState, String> {
    let window = ensure_window(&app, true)?;
    tokio::time::sleep(Duration::from_millis(600)).await;
    window_state(window).await
}

pub async fn get_state(app: AppHandle) -> Result<DoubaoWebState, String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Ok(DoubaoWebState {
            window_open: false,
            logged_in: false,
            current_url: None,
            message: "尚未打开豆包网页版登录窗口".into(),
        });
    };
    window_state(window).await
}

pub async fn logout(app: AppHandle) -> Result<DoubaoWebState, String> {
    let window = ensure_window(&app, false)?;
    window
        .clear_all_browsing_data()
        .map_err(|error| format!("清理豆包登录状态失败: {error}"))?;
    let _ = window.navigate(Url::parse(DOUBAO_CHAT_URL).map_err(|error| error.to_string())?);
    Ok(DoubaoWebState {
        window_open: true,
        logged_in: false,
        current_url: Some(DOUBAO_CHAT_URL.into()),
        message: "豆包网页版登录状态已清除".into(),
    })
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
    let prompt = request.prompt.trim();
    if prompt.is_empty() {
        return Err("请填写视频提示词".into());
    }
    if !matches!(request.ratio.as_str(), "1:1" | "16:9" | "9:16") {
        return Err("豆包网页版当前仅支持 1:1、16:9、9:16".into());
    }

    let window = ensure_window(&app, false)?;
    wait_until_page_ready(&window).await?;
    let state = window_state(window.clone()).await?;
    if !state.logged_in {
        let _ = window.show();
        let _ = window.set_focus();
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
            &serde_json::to_string(&request.ratio).unwrap_or_default(),
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
                        return value
                            .get("result")
                            .cloned()
                            .ok_or_else(|| "豆包视频任务完成但没有返回结果".to_string());
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
  const queryString = () => {
    const samantha = localJson('samantha_web_web_id');
    const tea = localJson('__tea_cache_tokens_497858');
    const deviceId = samantha.web_id || '';
    const webId = tea.web_id || '';
    const params = new URLSearchParams({
      aid: '497858', device_id: deviceId, device_platform: 'web',
      fp: cookieValue('s_v_web_id'), language: 'zh', pc_version: '3.19.4',
      pkg_type: 'release_version', real_aid: '497858', region: '',
      samantha_web: '1', sys_region: '', tea_uuid: webId,
      'use-olympus-account': '1', version_code: '20800', web_id: webId,
      web_tab_id: crypto.randomUUID(),
    });
    const msToken = cookieValue('msToken');
    if (msToken) params.set('msToken', msToken);
    return params.toString();
  };
  const request = async (payload, timeoutMs) => {
    const csrf = cookieValue('passport_csrf_token');
    const headers = { 'Content-Type': 'application/json', 'agw-js-conv': 'str' };
    if (csrf) headers['x-tt-passport-csrf-token'] = csrf;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch('/samantha/chat/completion?' + queryString(), {
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
      const submitRaw = await request(payload, 60000);
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
      const resultRaw = await request({ task_id: asyncTaskId, event_id: 0 }, 320000);
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
    }
}
