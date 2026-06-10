//! Scoped agent API keys (plan §4.4): AI agents are first-class clients
//! with their own credentials — never borrowed human sessions.
//!
//! Key format: `vk_<id>_<32-byte-hex>`. Only a SHA-256 hash of the full
//! secret is stored; the secret is shown once at creation. Keys carry
//! scopes (e.g. `messages:read`, `messages:send`), an optional TTL and a
//! revoked flag. Storage is a JSON file next to accounts.json — same
//! deliberate Postgres-less choice as AccountStore, same upgrade path.

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::ApiError;

/// All scopes a key may hold. Human sessions implicitly hold all of them.
pub const ALL_SCOPES: &[&str] = &[
    "accounts:read",
    "telegram:login",
    "chats:read",
    "chats:write",
    "messages:read",
    "messages:send",
    "folders:read",
    "folders:write",
    "events:read",
    "calls:use",
    "stt:use",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentKeyRecord {
    pub id: String,
    pub user_id: String,
    pub name: String,
    /// SHA-256 hex of the full secret; the secret itself is never stored.
    pub key_hash: String,
    pub scopes: Vec<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub revoked: bool,
}

/// Identity attached to requests authenticated with an agent key.
#[derive(Debug, Clone)]
pub struct AgentIdentity {
    pub key_id: String,
    pub scopes: Vec<String>,
}

impl AgentIdentity {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub struct AgentKeyStore {
    path: PathBuf,
    keys: Mutex<Vec<AgentKeyRecord>>,
}

impl AgentKeyStore {
    pub fn open(path: PathBuf) -> Result<Self> {
        let keys = match std::fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).context("agent keys file is malformed")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e).context("failed to read agent keys file"),
        };
        Ok(Self { path, keys: Mutex::new(keys) })
    }

    fn persist(&self, keys: &[AgentKeyRecord]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(keys)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Create a key; returns the record and the full secret (shown once).
    pub fn create(
        &self,
        user_id: &str,
        name: &str,
        scopes: Vec<String>,
        ttl_secs: Option<u64>,
    ) -> Result<(AgentKeyRecord, String), ApiError> {
        for scope in &scopes {
            if !ALL_SCOPES.contains(&scope.as_str()) {
                return Err(ApiError::BadRequest(format!("Unknown scope: {scope}")));
            }
        }
        if scopes.is_empty() {
            return Err(ApiError::BadRequest("At least one scope is required".into()));
        }

        let id = format!("ak{}", random_hex(4));
        let secret = format!("vk_{}_{}", id, random_hex(32));
        let record = AgentKeyRecord {
            id,
            user_id: user_id.to_string(),
            name: name.to_string(),
            key_hash: sha256_hex(&secret),
            scopes,
            created_at: now(),
            expires_at: ttl_secs.map(|t| now() + t as i64),
            revoked: false,
        };

        let mut keys = self.keys.lock().unwrap();
        keys.push(record.clone());
        self.persist(&keys).map_err(ApiError::internal)?;
        Ok((record, secret))
    }

    /// Resolve a presented secret to an identity. None = invalid/revoked/expired.
    pub fn authenticate(&self, secret: &str) -> Option<(String, AgentIdentity)> {
        // vk_<id>_<hex> — extract the id to find the record.
        let rest = secret.strip_prefix("vk_")?;
        let (id, _) = rest.split_once('_')?;

        let keys = self.keys.lock().unwrap();
        let record = keys.iter().find(|k| k.id == id)?;
        if record.revoked {
            return None;
        }
        if let Some(exp) = record.expires_at {
            if now() >= exp {
                return None;
            }
        }
        // Hash comparison: both sides are fixed-length sha256 hex.
        if !constant_time_eq(sha256_hex(secret).as_bytes(), record.key_hash.as_bytes()) {
            return None;
        }
        Some((
            record.user_id.clone(),
            AgentIdentity { key_id: record.id.clone(), scopes: record.scopes.clone() },
        ))
    }

    /// Keys owned by a user, hashes omitted by the caller (serialization
    /// of the full record is private to the store file).
    pub fn list_for(&self, user_id: &str) -> Vec<AgentKeyRecord> {
        self.keys
            .lock()
            .unwrap()
            .iter()
            .filter(|k| k.user_id == user_id)
            .cloned()
            .collect()
    }

    /// Revoke a key the user owns. Ok(false) = no such key.
    pub fn revoke(&self, user_id: &str, key_id: &str) -> Result<bool, ApiError> {
        let mut keys = self.keys.lock().unwrap();
        let Some(record) = keys.iter_mut().find(|k| k.id == key_id && k.user_id == user_id)
        else {
            return Ok(false);
        };
        record.revoked = true;
        self.persist(&keys).map_err(ApiError::internal)?;
        Ok(true)
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, AgentKeyStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = AgentKeyStore::open(dir.path().join("agent-keys.json")).unwrap();
        (dir, store)
    }

    #[test]
    fn create_and_authenticate() {
        let (_dir, store) = store();
        let (record, secret) = store
            .create("alice", "bot", vec!["messages:read".into()], None)
            .unwrap();
        assert!(secret.starts_with(&format!("vk_{}_", record.id)));

        let (user, identity) = store.authenticate(&secret).expect("valid key");
        assert_eq!(user, "alice");
        assert_eq!(identity.key_id, record.id);
        assert!(identity.has_scope("messages:read"));
        assert!(!identity.has_scope("messages:send"));

        // Wrong secret with a valid id prefix fails.
        assert!(store.authenticate(&format!("vk_{}_{}", record.id, "0".repeat(64))).is_none());
        assert!(store.authenticate("garbage").is_none());
    }

    #[test]
    fn unknown_or_empty_scopes_rejected() {
        let (_dir, store) = store();
        assert!(store.create("a", "x", vec!["nuke:all".into()], None).is_err());
        assert!(store.create("a", "x", vec![], None).is_err());
    }

    #[test]
    fn revoked_key_stops_authenticating() {
        let (_dir, store) = store();
        let (record, secret) = store
            .create("alice", "bot", vec!["chats:read".into()], None)
            .unwrap();
        assert!(store.authenticate(&secret).is_some());
        assert!(store.revoke("alice", &record.id).unwrap());
        assert!(store.authenticate(&secret).is_none());
        // Another user cannot revoke what they don't own.
        assert!(!store.revoke("bob", &record.id).unwrap());
    }

    #[test]
    fn expired_key_stops_authenticating() {
        let (_dir, store) = store();
        let (_, secret) = store
            .create("alice", "bot", vec!["chats:read".into()], Some(0))
            .unwrap();
        assert!(store.authenticate(&secret).is_none());
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-keys.json");
        let secret = {
            let store = AgentKeyStore::open(path.clone()).unwrap();
            store.create("alice", "bot", vec!["chats:read".into()], None).unwrap().1
        };
        let reopened = AgentKeyStore::open(path).unwrap();
        assert!(reopened.authenticate(&secret).is_some());
    }
}
