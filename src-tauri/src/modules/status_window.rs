use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

use crate::modules::logger;

pub const STATUS_WINDOW_LABEL: &str = "status-window";

fn status_window_config(
    app: &AppHandle<impl Runtime>,
) -> Result<&tauri::utils::config::WindowConfig, String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|item| item.label == STATUS_WINDOW_LABEL)
        .ok_or_else(|| "status_window_config_not_found".to_string())
}

fn ensure_status_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(STATUS_WINDOW_LABEL) {
        apply_native_status_window_shape(&window)?;
        return Ok(window);
    }

    let window = WebviewWindowBuilder::from_config(app, status_window_config(app)?)
        .map_err(|err| err.to_string())?
        .build()
        .map_err(|err| err.to_string())?;

    apply_native_status_window_shape(&window)?;
    logger::log_info("[StatusWindow] 模型额度与出口状态窗口已创建");
    Ok(window)
}

#[cfg(target_os = "windows")]
pub fn apply_native_status_window_shape<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};

    // Tauri and this crate currently resolve different `windows` crate minor
    // versions. Rebuild the transparent handle from its raw pointer so Win32
    // GDI receives the HWND type from this module's windows 0.58 binding.
    let tauri_hwnd = window.hwnd().map_err(|err| err.to_string())?;
    let hwnd = windows::Win32::Foundation::HWND(tauri_hwnd.0 as *mut core::ffi::c_void);
    let size = window.outer_size().map_err(|err| err.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let diameter = (32.0 * scale).round().clamp(24.0, 72.0) as i32;
    let region = unsafe {
        CreateRoundRectRgn(
            0,
            0,
            size.width.saturating_add(1) as i32,
            size.height.saturating_add(1) as i32,
            diameter,
            diameter,
        )
    };
    if region.is_invalid() {
        return Err("status_window_round_region_create_failed".to_string());
    }

    // A successful SetWindowRgn transfers ownership of HRGN to Windows and also
    // changes native hit testing, so the transparent CSS corners are no longer
    // part of the rectangular window surface.
    if unsafe { SetWindowRgn(hwnd, region, true) } == 0 {
        unsafe {
            let _ = DeleteObject(region);
        }
        return Err("status_window_round_region_apply_failed".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn apply_native_status_window_shape<R: Runtime>(
    _window: &WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

pub fn show_status_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = ensure_status_window(app)?;
    apply_native_status_window_shape(&window)?;
    window.show().map_err(|err| err.to_string())?;
    window.unminimize().map_err(|err| err.to_string())?;
    window.set_focus().map_err(|err| err.to_string())
}

pub fn hide_status_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let status_window = app.get_webview_window(STATUS_WINDOW_LABEL);

    // When compact mode was entered by minimizing the main window, its close button
    // doubles as the deterministic way back to the full console. If the status window
    // was opened manually while main is already visible, this remains a plain hide.
    let Some(main_window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let main_is_visible = main_window.is_visible().unwrap_or(false);
    let main_is_minimized = main_window.is_minimized().unwrap_or(true);
    if main_is_visible && !main_is_minimized {
        if let Some(window) = status_window {
            window.hide().map_err(|err| err.to_string())?;
        }
        return Ok(());
    }

    let restore_epoch = crate::begin_main_window_restore();
    let restore_result = (|| -> Result<(), String> {
        main_window.show().map_err(|err| err.to_string())?;
        main_window.unminimize().map_err(|err| err.to_string())?;
        if let Err(err) = main_window.set_focus() {
            logger::log_warn(&format!(
                "[StatusWindow] 主窗口已恢复，但暂时无法获取焦点: {}",
                err
            ));
        }
        Ok(())
    })();
    if restore_result.is_err() {
        crate::finish_main_window_restore(restore_epoch, false);
    }
    restore_result?;

    if let Some(window) = &status_window {
        window.hide().map_err(|err| {
            crate::finish_main_window_restore(restore_epoch, false);
            err.to_string()
        })?;
    }

    let main_window_for_verify = main_window.clone();
    let status_window_for_fallback = status_window.clone();
    tauri::async_runtime::spawn(async move {
        // Keep the guard across the complete Windows resize/focus notification burst.
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        if !crate::is_main_window_restore_current(restore_epoch) {
            return;
        }

        let mut restored = main_window_for_verify.is_visible().unwrap_or(false)
            && !main_window_for_verify.is_minimized().unwrap_or(true);
        if !restored {
            let _ = main_window_for_verify.show();
            let _ = main_window_for_verify.unminimize();
            let _ = main_window_for_verify.set_focus();
            tokio::time::sleep(std::time::Duration::from_millis(450)).await;
            restored = main_window_for_verify.is_visible().unwrap_or(false)
                && !main_window_for_verify.is_minimized().unwrap_or(true);
        }

        if restored {
            crate::finish_main_window_restore(restore_epoch, true);
            logger::log_info("[StatusWindow] 已稳定恢复主窗口并关闭紧凑状态窗口");
            return;
        }

        if crate::finish_main_window_restore(restore_epoch, false) {
            logger::log_warn("[StatusWindow] 主窗口恢复验证失败，重新显示紧凑状态窗口");
            if let Some(window) = status_window_for_fallback {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    });

    logger::log_info("[StatusWindow] 已请求关闭紧凑状态窗口并恢复主窗口");
    Ok(())
}
