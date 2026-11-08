//! Native chat notifications that report clicks.
//!
//! tauri-plugin-notification has no click callback on desktop, so a click only
//! brings the app forward. On macOS we send the notification ourselves, wait for
//! the click on a helper thread, focus the main window and emit
//! `notification-clicked` so the UI can open the right chat.

use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClickedEvent {
    pub account_id: String,
    pub chat_id: i64,
}

/// Returns `true` when the notification was handled natively (click support),
/// `false` when the caller should fall back to the generic plugin.
#[tauri::command]
pub fn show_chat_notification(
    app: AppHandle,
    account_id: String,
    chat_id: i64,
    title: String,
    body: String,
    silent: bool,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::{Emitter, Manager};

        let bundle = if tauri::is_dev() {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        };

        std::thread::Builder::new()
            .name("notification-wait".into())
            .spawn(move || {
                // Only the first call has an effect; later calls report AlreadySet.
                let _ = mac_notification_sys::set_application(&bundle);

                let mut notification = mac_notification_sys::Notification::new();
                notification.title(&title).message(&body).wait_for_click(true);
                if !silent {
                    notification.default_sound();
                }

                match notification.send() {
                    Ok(mac_notification_sys::NotificationResponse::Click)
                    | Ok(mac_notification_sys::NotificationResponse::ActionButton(_)) => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit(
                            "notification-clicked",
                            NotificationClickedEvent { account_id, chat_id },
                        );
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "Failed to show notification"),
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, account_id, chat_id, title, body, silent);
        Ok(false)
    }
}
