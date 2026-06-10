//! Telegram client application

mod database;
mod events;
mod storage;
// pub: integration tests drive commands::local_api::spawn_local_api.
pub mod commands;

// The Telegram engine lives in the Tauri-free `vasya-core` crate; re-export
// it so existing `crate::telegram::...` paths keep working.
pub use vasya_core::telegram;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tauri::Manager;

/// Application state shared across all Tauri commands
pub struct AppState {
    pub storage: Option<Arc<dyn storage::DataStorage>>,
    pub client_manager: Option<Arc<telegram::TelegramClientManager>>,
    /// Pending login tokens (account_id -> LoginToken)
    pub pending_logins: Mutex<HashMap<String, grammers_client::types::LoginToken>>,
    /// Pending 2FA password tokens (account_id -> PasswordToken)
    pub pending_passwords: Mutex<HashMap<String, grammers_client::types::PasswordToken>>,
    /// Active voice/video calls
    pub active_calls: Arc<RwLock<telegram::call_state::ActiveCalls>>,
    /// Active group calls
    pub active_group_calls: Arc<RwLock<telegram::group_call_state::ActiveGroupCalls>>,
    /// VoIP sidecar process handle
    pub voip_sidecar: Option<commands::voip_sidecar::VoipSidecarHandle>,
    /// Forwards engine events to the embedded local API server while it runs.
    pub server_events: Arc<events::ServerEventForwarder>,
    /// Running embedded local API server (Settings toggle, desktop only).
    #[cfg(desktop)]
    pub local_api: Option<commands::local_api::LocalApiHandle>,
    #[allow(dead_code)]
    _logger_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            storage: None,
            client_manager: None,
            pending_logins: Mutex::new(HashMap::new()),
            pending_passwords: Mutex::new(HashMap::new()),
            active_calls: Arc::new(RwLock::new(telegram::call_state::ActiveCalls::default())),
            active_group_calls: Arc::new(RwLock::new(telegram::group_call_state::ActiveGroupCalls::default())),
            voip_sidecar: None,
            server_events: Arc::new(events::ServerEventForwarder::default()),
            #[cfg(desktop)]
            local_api: None,
            _logger_guard: None,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    let initial_state = AppState::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Arc::new(RwLock::new(initial_state)))
        .invoke_handler(tauri::generate_handler![
            commands::request_login_code,
            commands::verify_code,
            commands::check_password,
            commands::logout,
            commands::has_api_credentials,
            commands::update_api_credentials,
            commands::get_chats,
            commands::get_cached_chats,
            commands::start_loading_chats,
            commands::get_messages,
            commands::send_message,
            commands::send_media,
            commands::forward_messages,
            commands::download_media,
            commands::download_chat_photo,
            commands::get_user_photos,
            commands::mark_messages_read,
            commands::search_messages,
            commands::get_my_avatar,
            commands::delete_and_leave_chat,
            commands::create_group,
            commands::create_channel,
            commands::get_contacts,
            commands::get_stt_settings,
            commands::set_stt_settings,
            commands::transcribe_audio,
            commands::download_whisper_model,
            commands::get_whisper_models_status,
            commands::get_folders,
            commands::save_folder,
            commands::delete_folder,
            commands::get_tabs,
            commands::save_tabs,
            commands::get_storage_mode,
            commands::set_storage_mode,
            commands::get_forum_topics,
            commands::global_search,
            commands::search_all_messages,
            commands::request_call,
            commands::accept_call,
            commands::confirm_call,
            commands::discard_call,
            commands::toggle_call_mute,
            commands::set_call_volume,
            commands::create_group_call,
            commands::join_group_call,
            commands::leave_group_call,
            commands::toggle_group_call_mute,
            commands::get_group_call_participants,
            commands::start_local_api,
            commands::stop_local_api,
            commands::local_api_status,
            commands::set_remote_mode,
            commands::restart_app,
        ])
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data dir");

            std::fs::create_dir_all(&app_dir).expect("Failed to create app data directory");

            // Initialize logging into app_data_dir/logs/
            let logs_dir = app_dir.join("logs");
            std::fs::create_dir_all(&logs_dir).expect("Failed to create logs directory");

            let file_appender = tracing_appender::rolling::daily(&logs_dir, "telegram-client.log");
            let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

            tracing_subscriber::fmt()
                .with_writer(non_blocking)
                .with_ansi(false)
                .with_target(true)
                .with_thread_ids(true)
                .with_line_number(true)
                .with_file(true)
                .with_max_level(tracing::Level::DEBUG)
                .init();

            tracing::info!("=== Telegram Client Started ===");
            tracing::info!("Version: {}", env!("CARGO_PKG_VERSION"));
            tracing::info!("App data dir: {:?}", app_dir);

            // Store logger guard in state to keep it alive
            {
                let state = app.state::<Arc<RwLock<AppState>>>();
                let mut state = tauri::async_runtime::block_on(state.write());
                state._logger_guard = Some(guard);
            }

            let storage_mode = storage::StorageMode::default(); // Local by default
            let storage_box = tauri::async_runtime::block_on(
                storage::create_storage(&storage_mode, &app_dir)
            ).expect("Failed to create storage");

            let sessions_dir = app_dir.join("sessions");
            std::fs::create_dir_all(&sessions_dir).expect("Failed to create sessions directory");

            // Credentials baked into binary at compile time (via build.rs)
            let api_id = option_env!("TELEGRAM_API_ID")
                .and_then(|s| s.parse::<i32>().ok())
                .unwrap_or(0);

            let api_hash = option_env!("TELEGRAM_API_HASH")
                .unwrap_or_default()
                .to_string();

            let client_manager =
                telegram::TelegramClientManager::new(sessions_dir, api_id, api_hash);

            let state = app.state::<Arc<RwLock<AppState>>>();
            let app_handle = app.handle().clone();

            // Remote-server mode: leave the embedded engine cold — no local
            // sessions, no update pumps; the UI talks to an external
            // vasya-server over HttpTransport instead.
            let remote_mode = app_dir.join(commands::settings::REMOTE_MODE_MARKER).exists();
            if remote_mode {
                tracing::info!("Remote-server mode: embedded engine not started");
            }

            tauri::async_runtime::block_on(async {
                if !remote_mode {
                    if let Err(e) = client_manager.load_existing_sessions().await {
                        tracing::warn!(error = %e, "Failed to load sessions");
                    }
                }

                // Start updates handlers for loaded sessions
                let loaded_clients = client_manager.list_clients().await;
                let cm_arc = Arc::new(client_manager);

                let updates_ctx = {
                    let state_guard = state.read().await;
                    events::updates_context(&app_handle, &state_guard)
                };

                for account_id in &loaded_clients {
                    if let Err(e) = cm_arc.start_updates(account_id, updates_ctx.clone()).await {
                        tracing::warn!(
                            account_id = %account_id,
                            error = %e,
                            "Failed to start updates for loaded session"
                        );
                    }
                }

                let mut state = state.write().await;
                state.storage = Some(Arc::from(storage_box));
                state.client_manager = Some(cm_arc);
            });

            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Auth keys are persisted eagerly; this flushes the throttled
                // tail (updates state / peer cache) of every open session.
                let state = app_handle.state::<Arc<RwLock<AppState>>>();
                tauri::async_runtime::block_on(async {
                    let guard = state.read().await;
                    if let Some(cm) = guard.client_manager.as_ref() {
                        cm.flush_all_sessions().await;
                    }
                });
            }
        });
}
