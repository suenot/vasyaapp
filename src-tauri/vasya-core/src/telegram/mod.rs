//! Telegram module for handling Telegram API interactions

pub mod auth;
pub mod client_manager;
pub mod encrypted_session;
pub mod master_key;
pub mod updates;
pub mod dh;
pub mod peer;
pub mod call_state;
pub mod calls;
pub mod group_call_state;
pub mod group_calls;

pub use client_manager::TelegramClientManager;
