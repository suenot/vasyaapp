//! Telegram voice/video call commands.
//!
//! The MTProto signaling + DH key exchange now lives in
//! `vasya_core::telegram::calls`; these commands are thin Tauri wrappers that
//! resolve the account's client from `AppState` and delegate. Audio
//! mute/volume stay here because they drive the desktop VoIP sidecar, which a
//! headless server cannot run.

use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::State;

use crate::AppState;
use crate::telegram::call_state::*;
use crate::telegram::calls as engine;
use crate::commands::voip_sidecar;

/// Resolve the client wrapper + shared call registry for an account.
async fn call_context(
    account_id: &str,
    state: &State<'_, Arc<RwLock<AppState>>>,
) -> Result<
    (
        Arc<crate::telegram::client_manager::TelegramClientWrapper>,
        Arc<RwLock<ActiveCalls>>,
    ),
    String,
> {
    let state_guard = state.read().await;
    let client_manager = state_guard
        .client_manager
        .as_ref()
        .ok_or("Client manager not initialized")?;
    let wrapper = client_manager
        .get_client(account_id)
        .await
        .ok_or("Client not found for this account")?;
    let active_calls = state_guard.active_calls.clone();
    Ok((wrapper, active_calls))
}

#[tauri::command]
pub async fn request_call(
    account_id: String,
    user_id: i64,
    is_video: bool,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<CallInfoResponse, String> {
    tracing::info!(
        account_id = %account_id,
        user_id = user_id,
        is_video = is_video,
        "Requesting call"
    );
    let (wrapper, active_calls) = call_context(&account_id, &state).await?;
    engine::request_call(&wrapper, &active_calls, &account_id, user_id, is_video).await
}

#[tauri::command]
pub async fn accept_call(
    account_id: String,
    call_id: i64,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<CallInfoResponse, String> {
    tracing::info!(account_id = %account_id, call_id = call_id, "Accepting call");
    let (wrapper, active_calls) = call_context(&account_id, &state).await?;
    engine::accept_call(&wrapper, &active_calls, call_id).await
}

#[tauri::command]
pub async fn confirm_call(
    account_id: String,
    call_id: i64,
    g_b: Vec<u8>,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<CallInfoResponse, String> {
    tracing::info!(account_id = %account_id, call_id = call_id, "Confirming call");
    let (wrapper, active_calls) = call_context(&account_id, &state).await?;
    engine::confirm_call(&wrapper, &active_calls, call_id, g_b).await
}

#[tauri::command]
pub async fn discard_call(
    account_id: String,
    call_id: i64,
    reason: String,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!(
        account_id = %account_id,
        call_id = call_id,
        reason = %reason,
        "Discarding call"
    );
    let (wrapper, active_calls) = call_context(&account_id, &state).await?;
    engine::discard_call(&wrapper, &active_calls, call_id, &reason).await
}

#[tauri::command]
pub async fn toggle_call_mute(
    call_id: i64,
    muted: bool,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!(call_id = call_id, muted = muted, "Toggle call mute");
    let mut state_guard = state.write().await;
    if let Some(ref mut handle) = state_guard.voip_sidecar {
        handle.send_command(&voip_sidecar::SidecarCommand::Mute { muted })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_call_volume(
    call_id: i64,
    volume: f32,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!(call_id = call_id, volume = volume, "Set call volume");
    let mut state_guard = state.write().await;
    if let Some(ref mut handle) = state_guard.voip_sidecar {
        handle.send_command(&voip_sidecar::SidecarCommand::SetVolume { volume })?;
    }
    Ok(())
}
