//! Authentication commands for Tauri frontend

use grammers_client::SignInError;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::telegram::auth::{AuthToken, QrLoginStatus, UserInfo};
use crate::AppState;
use super::flood_wait::with_flood_wait_retry;

/// Mask a phone number for logging — keep only the last 4 digits to avoid
/// writing PII to disk-backed logs.
fn mask_phone(phone: &str) -> String {
    let digits: Vec<char> = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() <= 4 {
        return "***".to_string();
    }
    let last4: String = digits[digits.len() - 4..].iter().collect();
    format!("***{}", last4)
}

/// Request login code from Telegram
#[tauri::command]
pub async fn request_login_code(
    phone: String,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<AuthToken, String> {
    let state_guard = state.read().await;
    let client_manager = state_guard
        .client_manager
        .as_ref()
        .ok_or("Client manager not initialized")?;

    let api_id = client_manager.api_id();
    let api_hash = client_manager.api_hash();

    tracing::info!(
        phone = %mask_phone(&phone),
        api_id = api_id,
        api_hash_len = api_hash.len(),
        "Requesting login code"
    );

    if api_id == 0 || api_hash.is_empty() {
        return Err("Telegram API credentials not configured (api_id=0 or api_hash empty)".to_string());
    }

    let account_id = Uuid::new_v4().to_string();

    let wrapper = client_manager
        .create_client(account_id.clone(), phone.clone())
        .await
        .map_err(|e| format!("Failed to create client: {}", e))?;

    // Add timeout to prevent infinite hang
    let token = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        wrapper.client.request_login_code(&phone, &api_hash),
    )
    .await
    .map_err(|_| "Request timed out. Check your internet connection.".to_string())?
    .map_err(|e| format!("Failed to request login code: {}", e))?;

    // Store token for later verification
    state_guard.pending_logins.lock().await.insert(account_id.clone(), token);

    tracing::info!(account_id = %account_id, "Login code requested");
    Ok(AuthToken {
        token_data: account_id,
        phone,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginStart {
    account_id: String,
    url: String,
    expires_at: i32,
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum QrLoginOutcome {
    Pending { url: String, expires_at: i32 },
    PasswordRequired,
    Authorized { user: UserInfo },
}

#[tauri::command]
pub async fn start_qr_login(
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<QrLoginStart, String> {
    let manager = state
        .read()
        .await
        .client_manager
        .clone()
        .ok_or("Client manager not initialized")?;
    let account_id = Uuid::new_v4().to_string();
    let code = manager
        .start_qr_login(account_id.clone(), manager.api_id(), manager.api_hash())
        .await
        .map_err(|e| e.to_string())?;
    Ok(QrLoginStart {
        account_id,
        url: code.url,
        expires_at: code.expires_at,
    })
}

#[tauri::command]
pub async fn poll_qr_login(
    account_id: String,
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<QrLoginOutcome, String> {
    let (manager, updates_ctx) = {
        let state = state.read().await;
        let manager = state
            .client_manager
            .clone()
            .ok_or("Client manager not initialized")?;
        (manager, crate::events::updates_context(&app, &state))
    };
    match manager
        .poll_qr_login(&account_id)
        .await
        .map_err(|e| e.to_string())?
    {
        QrLoginStatus::Pending(code) => Ok(QrLoginOutcome::Pending {
            url: code.url,
            expires_at: code.expires_at,
        }),
        QrLoginStatus::PasswordRequired => Ok(QrLoginOutcome::PasswordRequired),
        QrLoginStatus::Authorized => {
            let user = manager
                .finish_qr_login(&account_id, updates_ctx)
                .await
                .map_err(|e| e.to_string())?;
            Ok(QrLoginOutcome::Authorized { user })
        }
    }
}

#[tauri::command]
pub async fn check_qr_password(
    account_id: String,
    password: String,
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<UserInfo, String> {
    let (manager, updates_ctx) = {
        let state = state.read().await;
        let manager = state
            .client_manager
            .clone()
            .ok_or("Client manager not initialized")?;
        (manager, crate::events::updates_context(&app, &state))
    };
    if !manager
        .check_qr_password(&account_id, password.as_bytes())
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("Invalid two-step verification password".into());
    }
    manager
        .finish_qr_login(&account_id, updates_ctx)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_qr_login(
    account_id: String,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    let manager = state
        .read()
        .await
        .client_manager
        .clone()
        .ok_or("Client manager not initialized")?;
    manager
        .cancel_qr_login(&account_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Verify the code entered by user
#[tauri::command]
pub async fn verify_code(
    token: String,
    code: String,
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<UserInfo, String> {
    let account_id = token;
    tracing::info!(account_id = %account_id, "Verifying code");

    let state_guard = state.read().await;

    // Get pending login token
    let login_token = state_guard
        .pending_logins
        .lock()
        .await
        .remove(&account_id)
        .ok_or("Login session expired or invalid")?;

    let client_manager = state_guard
        .client_manager
        .as_ref()
        .ok_or("Client manager not initialized")?;

    let wrapper = client_manager
        .get_client(&account_id)
        .await
        .ok_or("Client not found")?;

    match wrapper.client.sign_in(&login_token, &code).await {
        Ok(_user) => {
            client_manager
                .save_session(&account_id)
                .await
                .map_err(|e| format!("Failed to save session: {}", e))?;

            let me = wrapper
                .client
                .get_me()
                .await
                .map_err(|e| format!("Failed to get user info: {}", e))?;

            // Start real-time updates handler
            let updates_ctx = crate::events::updates_context(&app, &state_guard);
            if let Err(e) = client_manager.start_updates(&account_id, updates_ctx).await {
                tracing::error!(error = %e, "Failed to start updates handler");
            }

            tracing::info!(name = ?me.first_name(), "User signed in successfully");
            Ok(UserInfo {
                id: me.raw.id(),
                first_name: me.first_name().unwrap_or("").to_string(),
                last_name: me.last_name().map(|s| s.to_string()),
                username: me.username().map(|s| s.to_string()),
                phone: wrapper.phone.clone(),
            })
        }
        Err(SignInError::PasswordRequired(password_token)) => {
            state_guard
                .pending_passwords
                .lock()
                .await
                .insert(account_id.clone(), password_token);
            Err("2FA password required".to_string())
        }
        Err(e) => Err(format!("Sign in failed: {}", e)),
    }
}

/// Check 2FA password
#[tauri::command]
pub async fn check_password(
    account_id: String,
    password: String,
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<UserInfo, String> {
    tracing::info!(account_id = %account_id, "Checking 2FA password");

    let state_guard = state.read().await;

    let password_token = state_guard
        .pending_passwords
        .lock()
        .await
        .remove(&account_id)
        .ok_or("2FA session expired or invalid")?;

    let client_manager = state_guard
        .client_manager
        .as_ref()
        .ok_or("Client manager not initialized")?;

    let wrapper = client_manager
        .get_client(&account_id)
        .await
        .ok_or("Client not found")?;

    wrapper
        .client
        .check_password(password_token, password.as_bytes())
        .await
        .map_err(|e| format!("Password check failed: {}", e))?;

    client_manager
        .save_session(&account_id)
        .await
        .map_err(|e| format!("Failed to save session: {}", e))?;

    let me = wrapper
        .client
        .get_me()
        .await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    // Start real-time updates handler
    let updates_ctx = crate::events::updates_context(&app, &state_guard);
    if let Err(e) = client_manager.start_updates(&account_id, updates_ctx).await {
        tracing::error!(error = %e, "Failed to start updates handler");
    }

    tracing::info!(name = ?me.first_name(), "User signed in with 2FA");
    Ok(UserInfo {
        id: me.raw.id(),
        first_name: me.first_name().unwrap_or("").to_string(),
        last_name: me.last_name().map(|s| s.to_string()),
        username: me.username().map(|s| s.to_string()),
        phone: wrapper.phone.clone(),
    })
}

/// Get current user's avatar (downloads if not cached)
#[tauri::command]
pub async fn get_my_avatar(
    account_id: String,
    app: AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<Option<String>, String> {
    let wrapper = {
        let state_guard = state.read().await;
        let client_manager = state_guard
            .client_manager
            .as_ref()
            .ok_or("Client manager not initialized")?;
        client_manager
            .get_client(&account_id)
            .await
            .ok_or("Client not found for this account")?
    };

    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let avatars_dir = app_data_dir.join("media").join("avatars");
    tokio::fs::create_dir_all(&avatars_dir).await
        .map_err(|e| format!("Failed to create avatars directory: {}", e))?;

    let file_path = avatars_dir.join(format!("me_{}.jpg", account_id));

    if file_path.exists() {
        return Ok(Some(file_path.to_string_lossy().to_string()));
    }

    let me = wrapper.client.get_me().await
        .map_err(|e| format!("Failed to get user info: {}", e))?;

    let me_peer = grammers_client::types::Peer::User(me);

    let photo_result = with_flood_wait_retry(|| async {
        let mut photos = wrapper.client.iter_profile_photos(&me_peer);
        photos.next().await
    }).await;

    match photo_result {
        Ok(Some(photo)) => {
            let download_result = with_flood_wait_retry(|| async {
                wrapper.client.download_media(&photo, &file_path).await
            }).await;

            match download_result {
                Ok(()) => Ok(Some(file_path.to_string_lossy().to_string())),
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to download own avatar");
                    Ok(None)
                }
            }
        }
        Ok(None) => Ok(None),
        Err(e) => {
            tracing::warn!(error = %e, "Error getting own photos");
            Ok(None)
        }
    }
}

/// Logout current user
#[tauri::command]
pub async fn logout(
    account_id: String,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!(account_id = %account_id, "Logging out");

    let state_guard = state.read().await;
    let client_manager = state_guard
        .client_manager
        .as_ref()
        .ok_or("Client manager not initialized")?;

    client_manager
        .remove_client(&account_id)
        .await
        .map_err(|e| format!("Failed to logout: {}", e))?;

    Ok(())
}
