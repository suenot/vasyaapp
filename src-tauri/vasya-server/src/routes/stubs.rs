//! 501 stubs for this phase (agreed scope): 1:1 voice calls, group calls,
//! STT, and the app-specific storage-mode toggle. The routes exist so the
//! REST surface is complete and discoverable via OpenAPI; the engines
//! behind them (VoIP sidecar, Whisper) are desktop-only today.

use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

use crate::context::ServerContext;
use crate::error::ApiError;

async fn not_implemented_calls() -> ApiError {
    ApiError::NotImplemented(
        "Voice calls are not available on the server yet (Phase 2 scope)".into(),
    )
}

async fn not_implemented_stt() -> ApiError {
    ApiError::NotImplemented(
        "Speech-to-text is not available on the server yet (Phase 2 scope)".into(),
    )
}

async fn not_implemented_storage_mode() -> ApiError {
    ApiError::NotImplemented(
        "storage-mode is a desktop-app concept; server storage is fixed".into(),
    )
}

pub fn router() -> Router<Arc<ServerContext>> {
    Router::new()
        // 1:1 calls (request/accept/confirm/discard/volume/mute)
        .route("/accounts/{acc}/calls/request", post(not_implemented_calls))
        .route("/accounts/{acc}/calls/accept", post(not_implemented_calls))
        .route("/accounts/{acc}/calls/confirm", post(not_implemented_calls))
        .route("/accounts/{acc}/calls/discard", post(not_implemented_calls))
        .route("/accounts/{acc}/calls/volume", post(not_implemented_calls))
        .route("/accounts/{acc}/calls/mute", post(not_implemented_calls))
        // Group calls
        .route("/accounts/{acc}/group-calls", post(not_implemented_calls))
        .route("/accounts/{acc}/group-calls/join", post(not_implemented_calls))
        .route("/accounts/{acc}/group-calls/leave", post(not_implemented_calls))
        .route("/accounts/{acc}/group-calls/participants", get(not_implemented_calls))
        .route("/accounts/{acc}/group-calls/mute", post(not_implemented_calls))
        // STT
        .route("/stt/settings", get(not_implemented_stt))
        .route("/stt/settings", axum::routing::put(not_implemented_stt))
        .route("/stt/transcribe", post(not_implemented_stt))
        .route("/stt/models/download", post(not_implemented_stt))
        .route("/stt/models", get(not_implemented_stt))
        // Storage mode
        .route("/storage-mode", get(not_implemented_storage_mode))
        .route("/storage-mode", axum::routing::put(not_implemented_storage_mode))
}
