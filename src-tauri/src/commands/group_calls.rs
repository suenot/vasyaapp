//! Telegram group call commands.
//!
//! The MTProto signaling now lives in `vasya_core::telegram::group_calls`;
//! these commands are thin Tauri wrappers that resolve the account's client
//! from `AppState` and delegate.

use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::State;

use crate::AppState;
use crate::telegram::group_call_state::*;
use crate::telegram::group_calls as engine;

/// Resolve the client wrapper + shared group-call registry for an account.
async fn group_call_context(
    account_id: &str,
    state: &State<'_, Arc<RwLock<AppState>>>,
) -> Result<
    (
        Arc<crate::telegram::client_manager::TelegramClientWrapper>,
        Arc<RwLock<ActiveGroupCalls>>,
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
    let active_group_calls = state_guard.active_group_calls.clone();
    Ok((wrapper, active_group_calls))
}

#[tauri::command]
pub async fn create_group_call(
    account_id: String,
    chat_id: i64,
    title: Option<String>,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<GroupCallInfoResponse, String> {
    tracing::info!(account_id = %account_id, chat_id = chat_id, "Creating group call");
    let (wrapper, active_group_calls) = group_call_context(&account_id, &state).await?;
    engine::create_group_call(&wrapper, &active_group_calls, &account_id, chat_id, title).await
}

#[tauri::command]
pub async fn join_group_call(
    account_id: String,
    call_id: i64,
    access_hash: i64,
    chat_id: i64,
    muted: bool,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<GroupCallInfoResponse, String> {
    tracing::info!(
        account_id = %account_id,
        call_id = call_id,
        chat_id = chat_id,
        "Joining group call"
    );
    let (wrapper, active_group_calls) = group_call_context(&account_id, &state).await?;
    engine::join_group_call(
        &wrapper,
        &active_group_calls,
        &account_id,
        call_id,
        access_hash,
        chat_id,
        muted,
    )
    .await
}

#[tauri::command]
pub async fn leave_group_call(
    account_id: String,
    call_id: i64,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!(account_id = %account_id, call_id = call_id, "Leaving group call");
    let (wrapper, active_group_calls) = group_call_context(&account_id, &state).await?;
    engine::leave_group_call(&wrapper, &active_group_calls, call_id).await
}

#[tauri::command]
pub async fn toggle_group_call_mute(
    account_id: String,
    call_id: i64,
    muted: bool,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!(
        account_id = %account_id,
        call_id = call_id,
        muted = muted,
        "Toggle group call mute"
    );
    let (wrapper, active_group_calls) = group_call_context(&account_id, &state).await?;
    engine::toggle_group_call_mute(&wrapper, &active_group_calls, call_id, muted).await
}

#[tauri::command]
pub async fn get_group_call_participants(
    account_id: String,
    call_id: i64,
    access_hash: i64,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<GroupCallParticipant>, String> {
    tracing::info!(
        account_id = %account_id,
        call_id = call_id,
        "Getting group call participants"
    );
    let wrapper = {
        let state_guard = state.read().await;
        let client_manager = state_guard
            .client_manager
            .as_ref()
            .ok_or("Client manager not initialized")?;
        client_manager
            .get_client(&account_id)
            .await
            .ok_or("Client not found for this account")?
    };
    engine::get_group_call_participants(&wrapper, call_id, access_hash).await
}
