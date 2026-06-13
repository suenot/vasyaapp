//! 501 stub for the desktop-only storage-mode toggle. The route exists so the
//! REST surface is complete and discoverable via OpenAPI; the concept behind
//! it is desktop-only.
//!
//! Voice calls (1:1 + group) are implemented in [`crate::routes::calls`]
//! (signaling/control/state); only real-time call *audio* (1:1 volume/mute)
//! stays 501, handled there. Speech-to-text is implemented in
//! [`crate::routes::stt`] (cloud Deepgram on the server).

use axum::routing::get;
use axum::Router;
use std::sync::Arc;

use crate::context::ServerContext;
use crate::error::ApiError;

async fn not_implemented_storage_mode() -> ApiError {
    ApiError::NotImplemented(
        "storage-mode is a desktop-app concept; server storage is fixed".into(),
    )
}

pub fn router() -> Router<Arc<ServerContext>> {
    Router::new()
        // Storage mode
        .route("/storage-mode", get(not_implemented_storage_mode))
        .route("/storage-mode", axum::routing::put(not_implemented_storage_mode))
}
