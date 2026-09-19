//! Encrypted global provider settings and asynchronous text translation.
use crate::AppState;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;
use vasya_core::translation::{
    TranslationResult, TranslationService, TranslationSettings, TranslationSettingsUpdate,
};

async fn service(
    app: &AppHandle,
    state: &State<'_, Arc<RwLock<AppState>>>,
) -> Result<TranslationService, String> {
    let provider = state
        .read()
        .await
        .client_manager
        .as_ref()
        .ok_or("Telegram engine is not initialized")?
        .master_key_provider();
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data directory is unavailable")?;
    Ok(TranslationService::new(
        directory.join("translation/local/settings.enc"),
        provider,
    ))
}
#[tauri::command]
pub async fn get_translation_settings(
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<TranslationSettings, String> {
    service(&app, &state)
        .await?
        .settings()
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn set_translation_settings(
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
    settings: TranslationSettingsUpdate,
) -> Result<TranslationSettings, String> {
    service(&app, &state)
        .await?
        .update(settings)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn translate_text(
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
    text: String,
    target_language: String,
) -> Result<TranslationResult, String> {
    service(&app, &state)
        .await?
        .translate(&text, &target_language)
        .await
        .map_err(|e| e.to_string())
}
