// The hand-built OpenAPI document is one deep serde_json::json! literal.
#![recursion_limit = "256"]

//! vasya-server — Telegram session host as a library.
//!
//! Structural requirement (plan §1 №6): this is a *library* exposing a
//! router builder over a vasya-core engine handle, plus a thin standalone
//! binary (src/main.rs). The Tauri desktop app can mount the same router
//! on 127.0.0.1 in-process over the sessions its UI already uses
//! (embedded-local AuthMode, no Postgres), so local AI agents/MCP control
//! the running app; the standalone server runs the same code with JWT
//! auth and env-injected session master key.

pub mod accounts;
pub mod agent_keys;
pub mod audit;
pub mod auth;
pub mod context;
pub mod dto;
pub mod error;
pub mod flood;
pub mod graphql;
pub mod idempotency;
pub mod openapi;
pub mod peer;
pub mod policy;
pub mod rate_limit;
pub mod routes;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use vasya_core::events::BroadcastEventSink;
use vasya_core::TelegramClientManager;

pub use auth::AuthMode;
pub use context::ServerContext;
pub use rate_limit::RateLimitConfig;

/// Options for assembling a server context around an existing engine.
pub struct ServerOptions {
    pub auth: AuthMode,
    /// Directory for accounts.json, folder/tab stores and the media cache.
    pub data_dir: PathBuf,
    pub rate_limit: RateLimitConfig,
    /// Stricter per-key mutation quota for agent keys (plan §12).
    pub agent_rate_limit: RateLimitConfig,
    /// How long Idempotency-Key responses are replayable.
    pub idempotency_ttl: std::time::Duration,
    /// Broadcast bus capacity (events buffered per lagging subscriber).
    pub events_capacity: usize,
    /// Serve the GraphQL playground page (dev only).
    pub graphql_playground: bool,
}

impl ServerOptions {
    pub fn new(auth: AuthMode, data_dir: PathBuf) -> Self {
        Self {
            auth,
            data_dir,
            rate_limit: RateLimitConfig::default(),
            agent_rate_limit: RateLimitConfig {
                capacity: 5,
                refill_every: std::time::Duration::from_secs(5),
            },
            idempotency_ttl: std::time::Duration::from_secs(24 * 60 * 60),
            events_capacity: 1024,
            graphql_playground: false,
        }
    }
}

/// Build the shared server state around an existing `TelegramClientManager`.
///
/// The desktop app passes its own manager here (embedded mode); the
/// standalone binary creates one first. Update pumps are NOT started here —
/// call [`start_existing_sessions`] (standalone) or wire the pumps yourself
/// (the desktop app already runs them with its own sink).
pub fn build_context(
    manager: Arc<TelegramClientManager>,
    options: ServerOptions,
) -> Result<Arc<ServerContext>> {
    std::fs::create_dir_all(&options.data_dir).context("failed to create data dir")?;
    let media_dir = options.data_dir.join("media");
    std::fs::create_dir_all(&media_dir).context("failed to create media dir")?;

    let accounts = accounts::AccountStore::open(options.data_dir.join("accounts.json"))?;
    let agent_keys = agent_keys::AgentKeyStore::open(options.data_dir.join("agent-keys.json"))?;
    let audit = audit::AuditLog::open(options.data_dir.join("audit.log"))?;

    Ok(Arc::new(ServerContext {
        manager,
        events: Arc::new(BroadcastEventSink::new(options.events_capacity)),
        auth: options.auth,
        accounts,
        rate: rate_limit::RateLimiter::new(options.rate_limit),
        agent_keys,
        agent_rate: rate_limit::RateLimiter::new(options.agent_rate_limit),
        audit,
        idempotency: idempotency::IdempotencyStore::new(options.idempotency_ttl),
        chat_cache: tokio::sync::RwLock::new(Default::default()),
        pending_logins: tokio::sync::Mutex::new(Default::default()),
        pending_passwords: tokio::sync::Mutex::new(Default::default()),
        active_calls: Arc::new(tokio::sync::RwLock::new(Default::default())),
        active_group_calls: Arc::new(tokio::sync::RwLock::new(Default::default())),
        media_dir,
        data_dir: options.data_dir,
        graphql_playground: options.graphql_playground,
    }))
}

/// The complete axum application (all /api/v1 routes + auth middleware).
pub fn build_router(ctx: Arc<ServerContext>) -> axum::Router {
    routes::api_router(ctx)
}

/// Load sessions from disk and start an update pump (events → bus) for each.
/// Standalone-server boot path; returns the loaded account ids.
pub async fn start_existing_sessions(ctx: &ServerContext) -> Result<Vec<String>> {
    let loaded = ctx
        .manager
        .load_existing_sessions()
        .await
        .context("failed to load sessions")?;

    for account_id in &loaded {
        if let Err(e) = ctx.manager.start_updates(account_id, ctx.updates_context()).await {
            tracing::warn!(account_id = %account_id, error = %e, "Failed to start updates for loaded session");
        }
    }
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_app(token: &str) -> (tempfile::TempDir, axum::Router) {
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(TelegramClientManager::with_key_provider(
            dir.path().join("sessions"),
            1,
            "hash".into(),
            Arc::new(vasya_core::telegram::master_key::FileKeyProvider::new(
                dir.path().join("master.key"),
            )),
        ));
        let ctx = build_context(
            manager,
            ServerOptions::new(
                AuthMode::EmbeddedLocal { token: token.into() },
                dir.path().join("data"),
            ),
        )
        .unwrap();
        (dir, build_router(ctx))
    }

    async fn body_json(response: axum::response::Response) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn health_is_public() {
        let (_dir, app) = test_app("tok");
        let res = app
            .oneshot(Request::get("/api/v1/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["status"], "ok");
    }

    #[tokio::test]
    async fn openapi_is_public_and_lists_paths() {
        let (_dir, app) = test_app("tok");
        let res = app
            .oneshot(Request::get("/api/v1/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let doc = body_json(res).await;
        assert_eq!(doc["openapi"], "3.0.3");
        assert!(doc["paths"]["/api/v1/accounts/{acc}/chats"].is_object());
    }

    #[tokio::test]
    async fn protected_routes_require_token() {
        let (_dir, app) = test_app("tok");

        let res = app
            .clone()
            .oneshot(Request::get("/api/v1/accounts").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = app
            .clone()
            .oneshot(
                Request::get("/api/v1/accounts")
                    .header("Authorization", "Bearer wrong")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = app
            .oneshot(
                Request::get("/api/v1/accounts")
                    .header("Authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await, serde_json::json!([]));
    }

    #[tokio::test]
    async fn stubs_return_501() {
        // STT + storage-mode remain desktop-only stubs.
        let (_dir, app) = test_app("tok");
        let res = app
            .oneshot(
                Request::get("/api/v1/stt/models")
                    .header("Authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_IMPLEMENTED);
    }

    /// 1:1 call audio (mute/volume) is client-side only → documented 501 with
    /// an explanation, even though call *signaling* is implemented.
    #[tokio::test]
    async fn call_audio_endpoints_document_501() {
        let (_dir, app) = test_app("tok");
        for path in ["/api/v1/accounts/a1/calls/mute", "/api/v1/accounts/a1/calls/volume"] {
            let res = app
                .clone()
                .oneshot(
                    Request::post(path)
                        .header("Authorization", "Bearer tok")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::NOT_IMPLEMENTED, "{path}");
            let body = body_json(res).await;
            assert!(
                body["error"].as_str().unwrap().contains("client-side"),
                "expected client-side audio explanation, got {body}"
            );
        }
    }

    /// Call *signaling* routes are implemented (no longer 501): with a valid
    /// body but no live client for the account they resolve to 404, proving
    /// the request reached the handler instead of a stub.
    #[tokio::test]
    async fn call_signaling_routes_are_implemented() {
        let (_dir, app) = test_app("tok");
        let cases = [
            ("/api/v1/accounts/a1/calls/request", r#"{"userId":42,"isVideo":false}"#),
            ("/api/v1/accounts/a1/group-calls", r#"{"chatId":42}"#),
        ];
        for (path, json) in cases {
            let res = app
                .clone()
                .oneshot(
                    Request::post(path)
                        .header("Authorization", "Bearer tok")
                        .header("content-type", "application/json")
                        .body(Body::from(json))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{path}");
            assert_ne!(res.status(), StatusCode::NOT_IMPLEMENTED, "{path}");
        }
    }

    /// The audit/policy layer maps every /calls/* and /group-calls/* path to
    /// the `calls:use` scope (see policy.rs) — here we assert OpenAPI advertises
    /// the call surface as live (op-style) rather than as 501 stubs.
    #[tokio::test]
    async fn openapi_advertises_call_signaling() {
        let (_dir, app) = test_app("tok");
        let res = app
            .oneshot(Request::get("/api/v1/openapi.json").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let doc = body_json(res).await;
        let request = &doc["paths"]["/api/v1/accounts/{acc}/calls/request"]["post"];
        assert!(request["responses"]["200"].is_object(), "calls/request should be 200/live");
        assert!(request["responses"]["501"].is_null());
        // Audio-only endpoints stay documented 501.
        let mute = &doc["paths"]["/api/v1/accounts/{acc}/calls/mute"]["post"];
        assert!(mute["responses"]["501"].is_object(), "calls/mute stays 501");
    }

    #[tokio::test]
    async fn unknown_account_is_404_after_claim() {
        let (_dir, app) = test_app("tok");
        // Account gets claimed on first touch, but no client exists -> 404.
        let res = app
            .oneshot(
                Request::get("/api/v1/accounts/nope/chats")
                    .header("Authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn graphql_post_requires_auth_and_executes() {
        let (_dir, app) = test_app("tok");

        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/graphql")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"query":"{ accounts { accountId } }"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

        let res = app
            .oneshot(
                Request::post("/api/v1/graphql")
                    .header("Authorization", "Bearer tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"query":"{ accounts { accountId } }"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            body_json(res).await,
            serde_json::json!({ "data": { "accounts": [] } })
        );
    }

    #[tokio::test]
    async fn graphql_sdl_is_public() {
        let (_dir, app) = test_app("tok");
        let res = app
            .oneshot(Request::get("/api/v1/graphql/sdl").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let sdl = String::from_utf8(body.to_vec()).unwrap();
        assert!(sdl.contains("messageReceived"));
    }

    #[tokio::test]
    async fn playground_is_gated_by_option() {
        let (_dir, app) = test_app("tok");
        let res = app
            .oneshot(Request::get("/api/v1/graphql/playground").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        // With the dev flag on, the page is served.
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(TelegramClientManager::with_key_provider(
            dir.path().join("sessions"),
            1,
            "hash".into(),
            Arc::new(vasya_core::telegram::master_key::FileKeyProvider::new(
                dir.path().join("master.key"),
            )),
        ));
        let mut options = ServerOptions::new(
            AuthMode::EmbeddedLocal { token: "tok".into() },
            dir.path().join("data"),
        );
        options.graphql_playground = true;
        let ctx = build_context(manager, options).unwrap();
        let app = build_router(ctx);
        let res = app
            .oneshot(Request::get("/api/v1/graphql/playground").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    async fn create_agent_key(app: &axum::Router, scopes: &[&str]) -> (String, String) {
        let body = serde_json::json!({ "name": "test-bot", "scopes": scopes }).to_string();
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/agent-keys")
                    .header("Authorization", "Bearer tok")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        (
            json["id"].as_str().unwrap().to_string(),
            json["secret"].as_str().unwrap().to_string(),
        )
    }

    #[tokio::test]
    async fn agent_key_scopes_enforced_end_to_end() {
        let (_dir, app) = test_app("tok");
        let (_id, secret) = create_agent_key(&app, &["accounts:read", "chats:read"]).await;

        // In-scope read works (empty account list).
        let res = app
            .clone()
            .oneshot(
                Request::get("/api/v1/accounts")
                    .header("Authorization", format!("Bearer {secret}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // Out-of-scope mutation is rejected with the missing scope named.
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/accounts/a1/chats/5/messages")
                    .header("Authorization", format!("Bearer {secret}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"text":"hi"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(body_json(res).await["error"]
            .as_str()
            .unwrap()
            .contains("messages:send"));

        // Agents cannot manage keys or use GraphQL.
        for (method, path) in [
            ("GET", "/api/v1/agent-keys"),
            ("GET", "/api/v1/audit"),
            ("POST", "/api/v1/graphql"),
        ] {
            let res = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .header("Authorization", format!("Bearer {secret}"))
                        .header("content-type", "application/json")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn split_destructive_scopes_enforced() {
        let (_dir, app) = test_app("tok");

        // A key with login + chat-create but NOT the new destructive scopes
        // can no longer log out an account or delete a chat.
        let (_id, secret) =
            create_agent_key(&app, &["telegram:login", "chats:write"]).await;

        let forbidden = |method: &'static str, path: &'static str, want_scope: &'static str| {
            let app = app.clone();
            let secret = secret.clone();
            async move {
                let res = app
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(path)
                            .header("Authorization", format!("Bearer {secret}"))
                            .header("content-type", "application/json")
                            .body(Body::from("{}"))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} {path}");
                assert!(
                    body_json(res).await["error"].as_str().unwrap().contains(want_scope),
                    "{method} {path} should name {want_scope}"
                );
            }
        };

        // DELETE account now needs accounts:delete, not telegram:login.
        forbidden("DELETE", "/api/v1/accounts/a1", "accounts:delete").await;
        // DELETE chat now needs chats:delete, not chats:write.
        forbidden("DELETE", "/api/v1/accounts/a1/chats/5", "chats:delete").await;
        // Forward now needs messages:forward, not messages:send.
        let (_id, send_only) = create_agent_key(&app, &["messages:send"]).await;
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/accounts/a1/messages/forward")
                    .header("Authorization", format!("Bearer {send_only}"))
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(body_json(res).await["error"]
            .as_str()
            .unwrap()
            .contains("messages:forward"));

        // A key that DOES hold the destructive scope clears the scope gate
        // (it then fails later for the missing account, never with a scope error).
        let (_id, deleter) = create_agent_key(&app, &["accounts:delete"]).await;
        let res = app
            .oneshot(
                Request::delete("/api/v1/accounts/a1")
                    .header("Authorization", format!("Bearer {deleter}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        if status == StatusCode::FORBIDDEN {
            let err = body_json(res).await["error"].as_str().unwrap().to_string();
            assert!(!err.contains("scope"), "scope gate should pass, got: {err}");
        }
    }

    #[tokio::test]
    async fn per_account_allowlist_enforced() {
        let (_dir, app) = test_app("tok");

        // Create a key restricted to a single account via the allowlist.
        let body = serde_json::json!({
            "name": "scoped-bot",
            "scopes": ["chats:read"],
            "accountIds": ["acc-allowed"],
        })
        .to_string();
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/agent-keys")
                    .header("Authorization", "Bearer tok")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let json = body_json(res).await;
        assert_eq!(
            json["accountIds"].as_array().unwrap()[0].as_str().unwrap(),
            "acc-allowed"
        );
        let secret = json["secret"].as_str().unwrap().to_string();

        // A non-listed account is rejected with the allowlist error.
        let res = app
            .clone()
            .oneshot(
                Request::get("/api/v1/accounts/acc-other/chats")
                    .header("Authorization", format!("Bearer {secret}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(body_json(res).await["error"]
            .as_str()
            .unwrap()
            .contains("allowlist"));

        // The listed account clears the allowlist gate (no allowlist error).
        let res = app
            .oneshot(
                Request::get("/api/v1/accounts/acc-allowed/chats")
                    .header("Authorization", format!("Bearer {secret}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        if res.status() == StatusCode::FORBIDDEN {
            let err = body_json(res).await["error"].as_str().unwrap().to_string();
            assert!(!err.contains("allowlist"), "listed account blocked: {err}");
        }
    }

    #[tokio::test]
    async fn revoked_agent_key_is_unauthorized() {
        let (_dir, app) = test_app("tok");
        let (id, secret) = create_agent_key(&app, &["accounts:read"]).await;

        let res = app
            .clone()
            .oneshot(
                Request::delete(format!("/api/v1/agent-keys/{id}"))
                    .header("Authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        let res = app
            .oneshot(
                Request::get("/api/v1/accounts")
                    .header("Authorization", format!("Bearer {secret}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn audit_records_mutations_with_agent_identity() {
        let (_dir, app) = test_app("tok");
        let (id, secret) = create_agent_key(&app, &["folders:write", "folders:read"]).await;

        // Agent performs a mutation (folder save claims acc + writes file).
        let folder = serde_json::json!({
            "id": "f1", "account_id": "acc-a", "name": "Work", "icon": null,
            "included_chat_types": [], "excluded_chat_types": [],
            "included_chat_ids": [], "excluded_chat_ids": [], "sort_order": 1
        });
        let res = app
            .clone()
            .oneshot(
                Request::post("/api/v1/accounts/acc-a/folders")
                    .header("Authorization", format!("Bearer {secret}"))
                    .header("content-type", "application/json")
                    .body(Body::from(folder.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);

        // The audit log has the row, attributed to the agent key.
        let res = app
            .oneshot(
                Request::get("/api/v1/audit?limit=10")
                    .header("Authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let entries = body_json(res).await;
        let entry = entries
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["path"] == "/api/v1/accounts/acc-a/folders")
            .expect("audit row for the mutation");
        assert_eq!(entry["method"], "POST");
        assert_eq!(entry["status"], 204);
        assert_eq!(entry["agentKeyId"], id.as_str());
        assert_eq!(entry["userId"], "local");
    }

    #[tokio::test]
    async fn idempotency_key_replays_response() {
        let (_dir, app) = test_app("tok");
        let folder = serde_json::json!({
            "id": "f1", "account_id": "acc-b", "name": "Inbox", "icon": null,
            "included_chat_types": [], "excluded_chat_types": [],
            "included_chat_ids": [], "excluded_chat_ids": [], "sort_order": 1
        })
        .to_string();

        let request = |app: &axum::Router| {
            app.clone().oneshot(
                Request::post("/api/v1/accounts/acc-b/folders")
                    .header("Authorization", "Bearer tok")
                    .header("content-type", "application/json")
                    .header("Idempotency-Key", "same-key-123")
                    .body(Body::from(folder.clone()))
                    .unwrap(),
            )
        };

        let first = request(&app).await.unwrap();
        assert_eq!(first.status(), StatusCode::NO_CONTENT);
        assert!(first.headers().get("idempotency-replayed").is_none());

        let second = request(&app).await.unwrap();
        assert_eq!(second.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            second.headers().get("idempotency-replayed").map(|v| v.to_str().unwrap()),
            Some("true")
        );
    }

    #[tokio::test]
    async fn agent_mutation_quota_is_stricter() {
        // Tight agent quota: a single mutation, then 429 — while the human
        // limiter (default burst 10) would still allow more.
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(TelegramClientManager::with_key_provider(
            dir.path().join("sessions"),
            1,
            "hash".into(),
            Arc::new(vasya_core::telegram::master_key::FileKeyProvider::new(
                dir.path().join("master.key"),
            )),
        ));
        let mut options = ServerOptions::new(
            AuthMode::EmbeddedLocal { token: "tok".into() },
            dir.path().join("data"),
        );
        options.agent_rate_limit = rate_limit::RateLimitConfig {
            capacity: 1,
            refill_every: std::time::Duration::from_secs(60),
        };
        let app = build_router(build_context(manager, options).unwrap());
        let (_id, secret) = create_agent_key(&app, &["folders:write"]).await;

        let folder = |id: &str| {
            serde_json::json!({
                "id": id, "account_id": "acc-c", "name": "x", "icon": null,
                "included_chat_types": [], "excluded_chat_types": [],
                "included_chat_ids": [], "excluded_chat_ids": [], "sort_order": 1
            })
            .to_string()
        };

        let send = |app: &axum::Router, body: String| {
            app.clone().oneshot(
                Request::post("/api/v1/accounts/acc-c/folders")
                    .header("Authorization", format!("Bearer {secret}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
        };

        assert_eq!(send(&app, folder("f1")).await.unwrap().status(), StatusCode::NO_CONTENT);
        let res = send(&app, folder("f2")).await.unwrap();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(res.headers().get("retry-after").is_some());
    }

    #[tokio::test]
    async fn credentials_status_reflects_manager() {
        let (_dir, app) = test_app("tok");
        let res = app
            .oneshot(
                Request::get("/api/v1/telegram/credentials")
                    .header("Authorization", "Bearer tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_json(res).await["configured"], true);
    }
}
