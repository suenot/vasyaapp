//! Shared peer resolution logic.
//!
//! The implementation lives in the Tauri-free `vasya-core` so the desktop
//! commands and the server routes share one resolver; re-exported here so
//! existing `crate::commands::peer_resolve::resolve_peer` call sites keep
//! working unchanged.

pub use crate::telegram::peer::resolve_peer;
