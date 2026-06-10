//! Settings commands

use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

use crate::AppState;
use crate::storage::StorageMode;

/// Check if API credentials are already configured in the backend (e.g. from bundled .env)
/// Returns true if valid credentials exist, without exposing the actual values.
#[tauri::command]
pub async fn has_api_credentials(
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<bool, String> {
    let state_guard = state.read().await;
    let client_manager = state_guard
        .client_manager
        .as_ref()
        .ok_or("Client manager not initialized")?;

    let api_id = client_manager.api_id();
    let api_hash = client_manager.api_hash();
    Ok(api_id != 0 && !api_hash.is_empty())
}

/// Update API credentials in place (no manager replacement to avoid UpdateStream drop panics)
#[tauri::command]
pub async fn update_api_credentials(
    api_id: i32,
    api_hash: String,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!("Updating API credentials: api_id={}", api_id);

    let state_guard = state.read().await;
    let client_manager = state_guard
        .client_manager
        .as_ref()
        .ok_or("Client manager not initialized")?;

    client_manager.update_credentials(api_id, api_hash);

    tracing::info!("API credentials updated successfully");
    Ok(())
}

/// Get current storage mode
#[tauri::command]
pub async fn get_storage_mode(
    _state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<StorageMode, String> {
    // For now, return Local as default
    // TODO: persist in settings
    Ok(StorageMode::Local)
}

/// Marker file checked at startup: when present, the embedded engine stays
/// cold (no sessions loaded, no update pumps) and the UI talks to an
/// external vasya-server over HTTP instead.
pub const REMOTE_MODE_MARKER: &str = "remote-mode";

/// Persist the remote-server mode flag. Takes effect on the NEXT app start
/// (the frontend restarts the app right after flipping it).
#[tauri::command]
pub async fn set_remote_mode(enabled: bool, app: AppHandle) -> Result<(), String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let marker = app_dir.join(REMOTE_MODE_MARKER);

    let result = if enabled {
        std::fs::write(&marker, b"1")
    } else {
        match std::fs::remove_file(&marker) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    };
    result.map_err(|e| format!("Failed to update remote-mode marker: {}", e))?;

    tracing::info!(enabled, "Remote-server mode flag updated (applies on restart)");
    Ok(())
}

/// Relaunch the app (used after switching the engine mode).
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// Switch storage mode
#[tauri::command]
pub async fn set_storage_mode(
    mode: StorageMode,
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    let app_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let new_storage = crate::storage::create_storage(&mode, &app_dir)
        .await
        .map_err(|e| format!("Failed to create storage: {}", e))?;

    let mut state_guard = state.write().await;
    state_guard.storage = Some(Arc::from(new_storage));

    tracing::info!(?mode, "Storage mode switched");
    Ok(())
}
