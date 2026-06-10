//! Agent API key management + audit log access. Human sessions only —
//! the agent policy middleware rejects agent keys on these routes.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::agent_keys::ALL_SCOPES;
use crate::audit::AuditEntry;
use crate::auth::UserId;
use crate::context::ServerContext;
use crate::error::ApiError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateKeyRequest {
    pub name: String,
    pub scopes: Vec<String>,
    /// Optional TTL in seconds.
    pub ttl_secs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedKeyResponse {
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    /// Shown exactly once — only a hash is stored.
    pub secret: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySummary {
    pub id: String,
    pub name: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub revoked: bool,
}

pub async fn create_key(
    State(ctx): State<Arc<ServerContext>>,
    user: Extension<UserId>,
    Json(req): Json<CreateKeyRequest>,
) -> Result<Json<CreatedKeyResponse>, ApiError> {
    let (record, secret) = ctx
        .agent_keys
        .create(&user.0 .0, &req.name, req.scopes, req.ttl_secs)?;
    tracing::info!(key_id = %record.id, user = %user.0 .0, "Agent key created");
    Ok(Json(CreatedKeyResponse {
        id: record.id,
        name: record.name,
        scopes: record.scopes,
        created_at: record.created_at,
        expires_at: record.expires_at,
        secret,
    }))
}

pub async fn list_keys(
    State(ctx): State<Arc<ServerContext>>,
    user: Extension<UserId>,
) -> Json<Vec<KeySummary>> {
    let keys = ctx
        .agent_keys
        .list_for(&user.0 .0)
        .into_iter()
        .map(|k| KeySummary {
            id: k.id,
            name: k.name,
            scopes: k.scopes,
            created_at: k.created_at,
            expires_at: k.expires_at,
            revoked: k.revoked,
        })
        .collect();
    Json(keys)
}

pub async fn revoke_key(
    State(ctx): State<Arc<ServerContext>>,
    user: Extension<UserId>,
    Path(key_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if ctx.agent_keys.revoke(&user.0 .0, &key_id)? {
        tracing::info!(key_id = %key_id, user = %user.0 .0, "Agent key revoked");
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound("No such key".into()))
    }
}

/// The valid scope names, for UIs building key-creation forms.
pub async fn list_scopes() -> Json<Vec<&'static str>> {
    Json(ALL_SCOPES.to_vec())
}

#[derive(Deserialize)]
pub struct AuditQuery {
    pub limit: Option<usize>,
}

pub async fn read_audit(
    State(ctx): State<Arc<ServerContext>>,
    _user: Extension<UserId>,
    Query(q): Query<AuditQuery>,
) -> Result<Json<Vec<AuditEntry>>, ApiError> {
    Ok(Json(ctx.audit.recent(q.limit.unwrap_or(100).min(1000))?))
}
