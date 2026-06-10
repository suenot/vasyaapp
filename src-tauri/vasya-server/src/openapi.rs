//! Machine-readable API contract served at /openapi.json (plan §4.4:
//! agents read the schema themselves).
//!
//! Hand-built for this phase: the surface is still moving and a static
//! document keeps the dependency set lean; switching to utoipa derive once
//! the surface stabilizes is a drop-in change (same route).

use axum::Json;

fn op(summary: &str, tag: &str) -> serde_json::Value {
    serde_json::json!({ "summary": summary, "tags": [tag], "responses": { "200": { "description": "OK" } } })
}

fn stub_op(summary: &str, tag: &str) -> serde_json::Value {
    serde_json::json!({
        "summary": format!("{summary} (501 in this phase)"),
        "tags": [tag],
        "responses": { "501": { "description": "Not implemented in this phase" } }
    })
}

pub async fn openapi_json() -> Json<serde_json::Value> {
    let paths = serde_json::json!({
        "/api/v1/health": { "get": { "summary": "Health check (no auth)", "tags": ["meta"],
            "security": [], "responses": { "200": { "description": "OK" } } } },
        "/api/v1/events": { "get": op("SSE stream of realtime events (telegram:new-message, chat-loaded, …); ?account= filters to one account", "realtime") },

        "/api/v1/agent-keys": {
            "get": op("List the caller's agent API keys (human sessions only)", "agent-keys"),
            "post": { "summary": "Create a scoped agent API key; the secret is returned once (human sessions only)",
                "tags": ["agent-keys"],
                "requestBody": { "content": { "application/json": { "schema": { "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "scopes": { "type": "array", "items": { "type": "string" },
                            "description": "see GET /agent-keys/scopes" },
                        "ttlSecs": { "type": "integer", "nullable": true } },
                    "required": ["name", "scopes"] } } } },
                "responses": { "200": { "description": "{id, name, scopes, createdAt, expiresAt, secret}" } } }
        },
        "/api/v1/agent-keys/scopes": { "get": op("Valid scope names for agent keys", "agent-keys") },
        "/api/v1/agent-keys/{key_id}": { "delete": op("Revoke an agent key", "agent-keys") },
        "/api/v1/audit": { "get": op("Recent audit entries for mutating calls (?limit=, human sessions only)", "agent-keys") },

        "/api/v1/telegram/credentials": {
            "get": op("Whether Telegram api_id/api_hash are configured", "telegram-auth"),
            "put": { "summary": "Set Telegram api_id/api_hash", "tags": ["telegram-auth"],
                "requestBody": { "content": { "application/json": { "schema": { "type": "object",
                    "properties": { "api_id": { "type": "integer" }, "api_hash": { "type": "string" } },
                    "required": ["api_id", "api_hash"] } } } },
                "responses": { "204": { "description": "Updated" } } }
        },
        "/api/v1/telegram/login/code": { "post": { "summary": "Request a Telegram login code (starts a new account login)",
            "tags": ["telegram-auth"],
            "requestBody": { "content": { "application/json": { "schema": { "type": "object",
                "properties": { "phone": { "type": "string" } }, "required": ["phone"] } } } },
            "responses": { "200": { "description": "accountId + phone; next call /telegram/login/verify" } } } },
        "/api/v1/telegram/login/verify": { "post": { "summary": "Verify the login code",
            "tags": ["telegram-auth"],
            "requestBody": { "content": { "application/json": { "schema": { "type": "object",
                "properties": { "accountId": { "type": "string" }, "code": { "type": "string" } },
                "required": ["accountId", "code"] } } } },
            "responses": { "200": { "description": "{status: authorized, user} or {status: password_required}" } } } },
        "/api/v1/telegram/login/password": { "post": { "summary": "Complete login with the 2FA password",
            "tags": ["telegram-auth"],
            "requestBody": { "content": { "application/json": { "schema": { "type": "object",
                "properties": { "accountId": { "type": "string" }, "password": { "type": "string" } },
                "required": ["accountId", "password"] } } } },
            "responses": { "200": { "description": "{status: authorized, user}" } } } },

        "/api/v1/accounts": { "get": op("List the caller's telegram accounts", "accounts") },
        "/api/v1/accounts/{acc}": { "delete": op("Logout: disconnect, delete the session and release ownership", "accounts") },
        "/api/v1/accounts/{acc}/avatar": { "get": op("Own profile photo (image bytes)", "accounts") },

        "/api/v1/accounts/{acc}/chats": { "get": op("List chats; ?source=live forces a fresh dialog iteration (default serves the cache)", "chats") },
        "/api/v1/accounts/{acc}/chats/load": { "post": op("Start progressive chat loading; emits chat-loaded / chats-loading-complete events (202)", "chats") },
        "/api/v1/accounts/{acc}/chats/{chat_id}": { "delete": op("Delete history and leave the chat", "chats") },
        "/api/v1/accounts/{acc}/groups": { "post": op("Create a basic group {title, userIds}", "chats") },
        "/api/v1/accounts/{acc}/channels": { "post": op("Create a channel or megagroup {title, about, isMegagroup}", "chats") },
        "/api/v1/accounts/{acc}/contacts": { "get": op("User-type chats (contacts)", "chats") },
        "/api/v1/accounts/{acc}/chats/{chat_id}/photo": { "get": op("Chat profile photo (image bytes, disk-cached)", "chats") },
        "/api/v1/accounts/{acc}/chats/{chat_id}/photos": { "get": op("All profile photos: downloads to cache, returns URLs", "chats") },
        "/api/v1/accounts/{acc}/chats/{chat_id}/photos/{index}": { "get": op("One cached profile photo (image bytes)", "chats") },

        "/api/v1/accounts/{acc}/chats/{chat_id}/messages": {
            "get": op("Messages; query: offset_id, limit (default 50), topic_id for forum topics", "messages"),
            "post": op("Send a text message {text, topicId?}", "messages")
        },
        "/api/v1/accounts/{acc}/chats/{chat_id}/media": { "post": {
            "summary": "Send media: raw file bytes in the body; metadata in x-file-name (percent-encoded), x-mime-type, x-caption (percent-encoded) headers",
            "tags": ["messages"],
            "requestBody": { "content": { "application/octet-stream": { "schema": { "type": "string", "format": "binary" } } } },
            "responses": { "200": { "description": "The sent message" } } } },
        "/api/v1/accounts/{acc}/messages/forward": { "post": op("Forward messages {fromChatId, toChatId, messageIds}", "messages") },
        "/api/v1/accounts/{acc}/chats/{chat_id}/read": { "post": op("Mark messages read up to {maxId}", "messages") },
        "/api/v1/accounts/{acc}/chats/{chat_id}/messages/{message_id}/media": { "get": op("Download message media (file bytes)", "messages") },

        "/api/v1/accounts/{acc}/chats/{chat_id}/messages/search": { "get": op("Search within a chat; query: q, limit", "search") },
        "/api/v1/accounts/{acc}/search": { "get": op("Global search for users/groups/channels; query: q, limit", "search") },
        "/api/v1/accounts/{acc}/messages/search": { "get": op("Search messages across all chats; query: q, limit", "search") },

        "/api/v1/accounts/{acc}/chats/{chat_id}/topics": { "get": op("Forum topics of a supergroup", "topics") },

        "/api/v1/accounts/{acc}/folders": {
            "get": op("List UI folders", "folders"),
            "post": op("Create or update a folder", "folders")
        },
        "/api/v1/accounts/{acc}/folders/{folder_id}": { "delete": op("Delete a folder", "folders") },
        "/api/v1/accounts/{acc}/tabs": {
            "get": op("List UI tabs", "folders"),
            "put": op("Replace UI tabs", "folders")
        },

        "/api/v1/accounts/{acc}/calls/request": { "post": stub_op("Request a 1:1 call", "calls") },
        "/api/v1/accounts/{acc}/calls/accept": { "post": stub_op("Accept a call", "calls") },
        "/api/v1/accounts/{acc}/calls/confirm": { "post": stub_op("Confirm a call", "calls") },
        "/api/v1/accounts/{acc}/calls/discard": { "post": stub_op("Discard a call", "calls") },
        "/api/v1/accounts/{acc}/calls/volume": { "post": stub_op("Set call volume", "calls") },
        "/api/v1/accounts/{acc}/calls/mute": { "post": stub_op("Toggle call mute", "calls") },
        "/api/v1/accounts/{acc}/group-calls": { "post": stub_op("Create a group call", "calls") },
        "/api/v1/accounts/{acc}/group-calls/join": { "post": stub_op("Join a group call", "calls") },
        "/api/v1/accounts/{acc}/group-calls/leave": { "post": stub_op("Leave a group call", "calls") },
        "/api/v1/accounts/{acc}/group-calls/participants": { "get": stub_op("Group call participants", "calls") },
        "/api/v1/accounts/{acc}/group-calls/mute": { "post": stub_op("Toggle group call mute", "calls") },
        "/api/v1/stt/settings": { "get": stub_op("STT settings", "stt"), "put": stub_op("Update STT settings", "stt") },
        "/api/v1/stt/transcribe": { "post": stub_op("Transcribe audio", "stt") },
        "/api/v1/stt/models/download": { "post": stub_op("Download a Whisper model", "stt") },
        "/api/v1/stt/models": { "get": stub_op("Whisper model status", "stt") },
        "/api/v1/storage-mode": { "get": stub_op("Get storage mode", "meta"), "put": stub_op("Set storage mode", "meta") },
    });

    Json(serde_json::json!({
        "openapi": "3.0.3",
        "info": {
            "title": "vasya-api",
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Telegram session host. REST parity with the desktop command surface; realtime via SSE (/events) and GraphQL subscriptions (/graphql/ws). All endpoints except /health, /openapi.json and /graphql/sdl require `Authorization: Bearer <token>` — a user JWT (standalone), the local token (embedded), or a scoped agent key (`vk_...`). Mutating routes accept an `Idempotency-Key` header: repeated requests with the same key replay the first response (marked with `Idempotency-Replayed: true`). Mutations are rate-limited per account (and stricter per agent key); 429 responses carry Retry-After."
        },
        "components": {
            "securitySchemes": {
                "bearerAuth": { "type": "http", "scheme": "bearer" }
            }
        },
        "security": [ { "bearerAuth": [] } ],
        "paths": paths
    }))
}
