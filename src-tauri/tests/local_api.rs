//! Embedded local API server: loopback bind, token auth gate, shutdown.
//! Drives the same `spawn_local_api` path the Settings toggle uses (the
//! Tauri command is a thin wrapper adding AppState/event-forwarder wiring).

#![cfg(desktop)]

use std::sync::Arc;

use telegram_client_lib::commands::local_api::spawn_local_api;
use telegram_client_lib::telegram::master_key::FileKeyProvider;
use telegram_client_lib::telegram::TelegramClientManager;

#[tokio::test(flavor = "multi_thread")]
async fn local_api_requires_token_and_shuts_down() {
    let dir = tempfile::tempdir().unwrap();
    // FileKeyProvider: tests must not touch the user's Keychain.
    let manager = Arc::new(TelegramClientManager::with_key_provider(
        dir.path().join("sessions"),
        1,
        "hash".into(),
        Arc::new(FileKeyProvider::new(dir.path().join("master.key"))),
    ));

    // Port 0 = ephemeral, keeps parallel test runs from colliding.
    let (handle, _ctx) = spawn_local_api(manager, dir.path().join("local-api"), 0, None)
        .await
        .unwrap();
    assert_eq!(handle.token.len(), 64);
    let base = format!("http://127.0.0.1:{}", handle.port);
    let token = handle.token.clone();
    let client = reqwest::Client::new();

    // Health is public.
    let res = client.get(format!("{base}/api/v1/health")).send().await.unwrap();
    assert_eq!(res.status(), 200);

    // Data routes: 401 without / with a wrong token, 200 with the real one.
    let res = client.get(format!("{base}/api/v1/accounts")).send().await.unwrap();
    assert_eq!(res.status(), 401);
    let res = client
        .get(format!("{base}/api/v1/accounts"))
        .bearer_auth("wrong-token-wrong-token-wrong-token")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let res = client
        .get(format!("{base}/api/v1/accounts"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!([])
    );

    // Graceful shutdown: the port stops accepting connections.
    handle.shutdown();
    let mut closed = false;
    for _ in 0..20 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        // A fresh client avoids reusing a pooled (still-draining) connection.
        if reqwest::Client::new()
            .get(format!("{base}/api/v1/health"))
            .send()
            .await
            .is_err()
        {
            closed = true;
            break;
        }
    }
    assert!(closed, "server kept accepting connections after shutdown");
}

#[tokio::test]
async fn local_api_rejects_short_token() {
    let dir = tempfile::tempdir().unwrap();
    let manager = Arc::new(TelegramClientManager::with_key_provider(
        dir.path().join("sessions"),
        1,
        "hash".into(),
        Arc::new(FileKeyProvider::new(dir.path().join("master.key"))),
    ));

    // (no unwrap_err: ServerContext is not Debug)
    let err = match spawn_local_api(manager, dir.path().join("local-api"), 0, Some("short".into())).await {
        Err(e) => e,
        Ok(_) => panic!("expected the short token to be rejected"),
    };
    assert!(err.contains("32 characters"));
}
