//! Embedded local API server (desktop only): mounts the vasya-server router
//! in-process on 127.0.0.1 over the SAME sessions the UI uses, so local AI
//! agents / MCP clients control the running app with zero external infra
//! (plan §3.1, requirement №6).
//!
//! Security: loopback bind only; every request needs the bearer token the
//! app generated; the server dies with the toggle or the app process.

use serde::Serialize;

/// What the Settings UI needs to render the feature state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalApiStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub token: Option<String>,
}

impl LocalApiStatus {
    fn stopped() -> Self {
        Self { running: false, port: None, token: None }
    }
}

#[cfg(desktop)]
pub use desktop::*;

#[cfg(desktop)]
mod desktop {
    use std::path::PathBuf;
    use std::sync::Arc;

    use tauri::{AppHandle, Manager, State};
    use tokio::sync::RwLock;
    use vasya_core::events::EventSink;
    use vasya_core::TelegramClientManager;
    use vasya_server::{AuthMode, ServerContext, ServerOptions};

    use super::LocalApiStatus;
    use crate::AppState;

    /// A running embedded server. Dropping the handle without `shutdown()`
    /// leaves the task running until the process exits.
    pub struct LocalApiHandle {
        pub port: u16,
        pub token: String,
        shutdown: tokio::sync::oneshot::Sender<()>,
    }

    impl LocalApiHandle {
        pub fn shutdown(self) {
            let _ = self.shutdown.send(());
        }
    }

    /// Bind 127.0.0.1:`port` (0 = ephemeral) and serve the vasya-server
    /// router over `manager`. Tauri-free so integration tests can drive it.
    pub async fn spawn_local_api(
        manager: Arc<TelegramClientManager>,
        data_dir: PathBuf,
        port: u16,
        token: Option<String>,
    ) -> Result<(LocalApiHandle, Arc<ServerContext>), String> {
        if let Some(t) = &token {
            // A short token would undo the whole auth story; the app only
            // ever passes back a previously generated 64-hex one.
            if t.len() < 32 {
                return Err("Local API token must be at least 32 characters".into());
            }
        }
        let auth = match token {
            Some(token) => AuthMode::EmbeddedLocal { token },
            None => AuthMode::embedded_with_random_token(),
        };
        let token = auth
            .embedded_token()
            .expect("embedded mode always has a token")
            .to_string();

        let ctx = vasya_server::build_context(manager, ServerOptions::new(auth, data_dir))
            .map_err(|e| format!("Failed to build local API context: {e}"))?;

        // Strictly loopback — never expose the session host on a real interface.
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|e| format!("Failed to bind 127.0.0.1:{port}: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to read local addr: {e}"))?
            .port();

        let router = vasya_server::build_router(ctx.clone());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let serve = axum::serve(listener, router).with_graceful_shutdown(async {
                rx.await.ok();
            });
            if let Err(e) = serve.await {
                tracing::error!(error = %e, "Local API server error");
            }
            tracing::info!("Local API server stopped");
        });

        tracing::info!(port, "Local API server listening on 127.0.0.1");
        Ok((LocalApiHandle { port, token, shutdown: tx }, ctx))
    }

    /// Start (or restart — e.g. token regeneration / port change) the local
    /// API server. `token: None` generates a fresh random token; the
    /// frontend persists the returned one and passes it back next time.
    #[tauri::command]
    pub async fn start_local_api(
        port: u16,
        token: Option<String>,
        app: AppHandle,
        state: State<'_, Arc<RwLock<AppState>>>,
    ) -> Result<LocalApiStatus, String> {
        let mut guard = state.write().await;

        if let Some(handle) = guard.local_api.take() {
            guard.server_events.set(None);
            handle.shutdown();
        }

        let manager = guard
            .client_manager
            .as_ref()
            .ok_or("Client manager not initialized")?
            .clone();
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {e}"))?
            .join("local-api");

        let (handle, ctx) = spawn_local_api(manager, data_dir, port, token).await?;

        // Update pumps feed the server bus (SSE / GraphQL subscriptions)
        // while the server runs.
        guard
            .server_events
            .set(Some(ctx.events.clone() as Arc<dyn EventSink>));

        let status = LocalApiStatus {
            running: true,
            port: Some(handle.port),
            token: Some(handle.token.clone()),
        };
        guard.local_api = Some(handle);
        Ok(status)
    }

    /// Stop the local API server. Idempotent.
    #[tauri::command]
    pub async fn stop_local_api(state: State<'_, Arc<RwLock<AppState>>>) -> Result<(), String> {
        let mut guard = state.write().await;
        guard.server_events.set(None);
        if let Some(handle) = guard.local_api.take() {
            handle.shutdown();
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn local_api_status(
        state: State<'_, Arc<RwLock<AppState>>>,
    ) -> Result<LocalApiStatus, String> {
        let guard = state.read().await;
        Ok(match &guard.local_api {
            Some(handle) => LocalApiStatus {
                running: true,
                port: Some(handle.port),
                token: Some(handle.token.clone()),
            },
            None => LocalApiStatus::stopped(),
        })
    }
}

// Mobile: the commands exist so the shared frontend can call them safely,
// but the server (and the vasya-server dependency) is desktop-only.
#[cfg(not(desktop))]
mod mobile {
    use super::LocalApiStatus;

    #[tauri::command]
    pub async fn start_local_api(
        _port: u16,
        _token: Option<String>,
    ) -> Result<LocalApiStatus, String> {
        Err("The local API server is desktop-only".into())
    }

    #[tauri::command]
    pub async fn stop_local_api() -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub async fn local_api_status() -> Result<LocalApiStatus, String> {
        Ok(LocalApiStatus::stopped())
    }
}

#[cfg(not(desktop))]
pub use mobile::*;
