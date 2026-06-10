//! Tauri adapter for vasya-core's event abstraction.
//!
//! Forwards engine events to the webview unchanged — same event names and
//! payload shapes the frontend has always listened for.

use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use vasya_core::events::{EventSink, MultiEventSink};
use vasya_core::telegram::updates::UpdatesContext;

use crate::AppState;

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(e) = self.app.emit(event, payload) {
            tracing::error!(error = %e, event, "Failed to emit Tauri event");
        }
    }
}

/// Forwards engine events to the embedded local API server's bus while the
/// server runs; a no-op otherwise. Lives in `AppState` for the app's
/// lifetime so update pumps never need rewiring when the server toggles.
#[derive(Default)]
pub struct ServerEventForwarder {
    target: std::sync::RwLock<Option<Arc<dyn EventSink>>>,
}

impl ServerEventForwarder {
    pub fn set(&self, sink: Option<Arc<dyn EventSink>>) {
        *self.target.write().unwrap() = sink;
    }
}

impl EventSink for ServerEventForwarder {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Some(sink) = self.target.read().unwrap().as_ref() {
            sink.emit(event, payload);
        }
    }
}

/// Build the updates context for `TelegramClientManager::start_updates`:
/// events go to the webview and (while it runs) the embedded local API
/// server's bus; call registries are the app-wide ones.
pub fn updates_context(app: &AppHandle, state: &AppState) -> UpdatesContext {
    UpdatesContext {
        sink: Arc::new(MultiEventSink::new(vec![
            Arc::new(TauriEventSink::new(app.clone())) as Arc<dyn EventSink>,
            state.server_events.clone(),
        ])),
        active_calls: state.active_calls.clone(),
        active_group_calls: state.active_group_calls.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarder_emits_only_while_target_is_set() {
        struct Capture(std::sync::Mutex<Vec<String>>);
        impl EventSink for Capture {
            fn emit(&self, event: &str, _payload: serde_json::Value) {
                self.0.lock().unwrap().push(event.to_string());
            }
        }

        let forwarder = ServerEventForwarder::default();
        forwarder.emit("dropped", serde_json::json!({}));

        let capture = Arc::new(Capture(std::sync::Mutex::new(Vec::new())));
        forwarder.set(Some(capture.clone()));
        forwarder.emit("forwarded", serde_json::json!({}));

        forwarder.set(None);
        forwarder.emit("dropped-again", serde_json::json!({}));

        assert_eq!(*capture.0.lock().unwrap(), vec!["forwarded".to_string()]);
    }
}
