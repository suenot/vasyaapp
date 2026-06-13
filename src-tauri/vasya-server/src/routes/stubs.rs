//! 501 stubs for desktop-only surfaces: STT (Whisper) and the app-specific
//! storage-mode toggle. The routes exist so the REST surface is complete and
//! discoverable via OpenAPI; the engines behind them are desktop-only today.
//!
//! Voice calls (1:1 + group) are no longer stubbed — they are implemented in
//! [`crate::routes::calls`] (signaling/control/state). Only real-time call
//! *audio* (1:1 volume/mute) stays 501, handled there.

use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;

use crate::context::ServerContext;
use crate::error::ApiError;

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
