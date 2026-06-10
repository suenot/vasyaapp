//! Shared media type classification — moved to vasya-core, re-exported
//! here so existing `crate::commands::media_types` paths keep working.

pub use vasya_core::media::classify_media_type;
