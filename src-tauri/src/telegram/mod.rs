//! Telegram module for handling Telegram API interactions

pub mod auth;
pub mod client_manager;
pub mod encrypted_session;
pub mod updates;
pub mod dh;
pub mod call_state;
pub mod group_call_state;

pub use client_manager::TelegramClientManager;
