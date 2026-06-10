//! Audit log: who (user / agent key), what (method + path), when, and the
//! outcome of every mutating call. Append-only JSONL in the data dir.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Epoch milliseconds.
    pub ts: i64,
    pub user_id: String,
    /// Set when the caller authenticated with an agent key.
    pub agent_key_id: Option<String>,
    pub method: String,
    /// Full request path — carries the target (account/chat) ids.
    pub path: String,
    pub status: u16,
}

pub struct AuditLog {
    path: PathBuf,
    file: Mutex<std::fs::File>,
}

impl AuditLog {
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .context("failed to open audit log")?;
        Ok(Self { path, file: Mutex::new(file) })
    }

    pub fn record(&self, entry: &AuditEntry) {
        let Ok(line) = serde_json::to_string(entry) else { return };
        let mut file = self.file.lock().unwrap();
        if let Err(e) = writeln!(file, "{line}") {
            tracing::error!(error = %e, "Failed to write audit entry");
        }
    }

    /// The most recent `limit` entries (reads the whole file — fine for the
    /// file-backed phase; a database store would query instead).
    pub fn recent(&self, limit: usize) -> Result<Vec<AuditEntry>, crate::error::ApiError> {
        // Take the lock so concurrent writes flush before we read.
        let _guard = self.file.lock().unwrap();
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(crate::error::ApiError::internal(e)),
        };
        let mut entries: Vec<AuditEntry> = raw
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        if entries.len() > limit {
            entries.drain(..entries.len() - limit);
        }
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::open(dir.path().join("audit.log")).unwrap();

        log.record(&AuditEntry {
            ts: 1,
            user_id: "alice".into(),
            agent_key_id: Some("ak01".into()),
            method: "POST".into(),
            path: "/api/v1/accounts/acc/chats/5/messages".into(),
            status: 200,
        });
        log.record(&AuditEntry {
            ts: 2,
            user_id: "alice".into(),
            agent_key_id: None,
            method: "DELETE".into(),
            path: "/api/v1/accounts/acc/folders/f1".into(),
            status: 204,
        });

        let entries = log.recent(10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].agent_key_id.as_deref(), Some("ak01"));
        assert_eq!(entries[1].method, "DELETE");

        // limit keeps the most recent entries
        let entries = log.recent(1).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].ts, 2);
    }
}
