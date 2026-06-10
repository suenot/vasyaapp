//! Message commands for retrieving and sending messages

use std::sync::Arc;
use tauri::State;
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};
use grammers_client::types::Message as GrammersMessage;
use grammers_session::defs::PeerRef;

use crate::AppState;
use grammers_client::types::Media;
use super::media_types::classify_media_type;
use super::peer_resolve::resolve_peer;

#[derive(Debug, Serialize, Deserialize)]
pub struct MediaInfo {
    pub media_type: String,
    pub file_path: Option<String>,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: i32,
    pub chat_id: i64,
    pub from_user_id: Option<i64>,
    pub sender_name: Option<String>,
    pub text: Option<String>,
    pub date: i64,
    pub is_outgoing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<Vec<MediaInfo>>,
}

/// Extract media information from a message
fn extract_media_info(msg: &GrammersMessage) -> Option<Vec<MediaInfo>> {
    msg.media().map(|media| {
        let media_type = classify_media_type(&media).to_string();
        let (file_size, mime_type) = match &media {
            Media::Document(doc) => (
                Some(doc.size() as u64),
                doc.mime_type().map(|s| s.to_string()),
            ),
            Media::Photo(_) => (None, Some("image/jpeg".to_string())),
            _ => (None, None),
        };
        vec![MediaInfo {
            media_type,
            file_path: None,
            file_name: None,
            file_size,
            mime_type,
        }]
    })
}

/// Get messages from a chat (or from a specific forum topic when topic_id is provided)
#[tauri::command]
pub async fn get_messages(
    account_id: String,
    chat_id: i64,
    offset_id: Option<i32>,
    limit: Option<usize>,
    topic_id: Option<i32>,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<Message>, String> {
    tracing::info!(
        account_id = %account_id,
        chat_id = chat_id,
        offset_id = ?offset_id,
        topic_id = ?topic_id,
        "Getting messages"
    );

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
    }; // state_guard dropped here

    let chat = resolve_peer(&wrapper, chat_id).await?;
    let limit = limit.unwrap_or(50);

    // For forum topics, use messages.getReplies with msg_id = topic_id
    if let Some(tid) = topic_id {
        let input_peer: grammers_tl_types::enums::InputPeer = PeerRef::from(&chat).into();
        let request = grammers_tl_types::functions::messages::GetReplies {
            peer: input_peer,
            msg_id: tid,
            offset_id: offset_id.unwrap_or(0),
            offset_date: 0,
            add_offset: 0,
            limit: limit as i32,
            max_id: 0,
            min_id: 0,
            hash: 0,
        };

        let result = wrapper
            .client
            .invoke(&request)
            .await
            .map_err(|e| format!("Failed to get topic messages: {}", e))?;

        let (raw_messages, raw_users, raw_chats) = match result {
            grammers_tl_types::enums::messages::Messages::Messages(m) => (m.messages, m.users, m.chats),
            grammers_tl_types::enums::messages::Messages::Slice(m) => (m.messages, m.users, m.chats),
            grammers_tl_types::enums::messages::Messages::ChannelMessages(m) => (m.messages, m.users, m.chats),
            grammers_tl_types::enums::messages::Messages::NotModified(_) => (Vec::new(), Vec::new(), Vec::new()),
        };

        // Build user/chat name lookup
        let mut names: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        for user in &raw_users {
            if let grammers_tl_types::enums::User::User(u) = user {
                let first = u.first_name.as_deref().unwrap_or("");
                let last = u.last_name.as_deref().unwrap_or("");
                let name = if last.is_empty() { first.to_string() } else { format!("{} {}", first, last) };
                names.insert(u.id, name);
            }
        }
        for chat in &raw_chats {
            match chat {
                grammers_tl_types::enums::Chat::Channel(ch) => { names.insert(ch.id, ch.title.clone()); }
                grammers_tl_types::enums::Chat::Chat(ch) => { names.insert(ch.id, ch.title.clone()); }
                _ => {}
            }
        }

        let messages: Vec<Message> = raw_messages
            .into_iter()
            .filter_map(|m| {
                match m {
                    grammers_tl_types::enums::Message::Message(msg) => {
                        let from_user_id = msg.from_id.as_ref().map(|p| match p {
                            grammers_tl_types::enums::Peer::User(u) => u.user_id,
                            grammers_tl_types::enums::Peer::Chat(c) => c.chat_id,
                            grammers_tl_types::enums::Peer::Channel(c) => c.channel_id,
                        });
                        let sender_name = msg.from_id.as_ref().and_then(|p| {
                            let id = match p {
                                grammers_tl_types::enums::Peer::User(u) => u.user_id,
                                grammers_tl_types::enums::Peer::Chat(c) => c.chat_id,
                                grammers_tl_types::enums::Peer::Channel(c) => c.channel_id,
                            };
                            names.get(&id).cloned()
                        });
                        Some(Message {
                            id: msg.id,
                            chat_id,
                            from_user_id,
                            sender_name,
                            text: if msg.message.is_empty() { None } else { Some(msg.message) },
                            date: msg.date as i64,
                            is_outgoing: msg.out,
                            media: None, // Raw TL media parsing would be complex; keep simple for now
                        })
                    }
                    _ => None,
                }
            })
            .collect();

        tracing::info!(count = messages.len(), chat_id = chat_id, topic_id = tid, "Topic messages loaded");
        return Ok(messages);
    }

    // Regular messages (no topic)
    let mut messages_iter = wrapper.client.iter_messages(&chat);

    if let Some(offset) = offset_id {
        messages_iter = messages_iter.offset_id(offset);
    }

    let mut messages = Vec::with_capacity(limit);
    let mut count = 0;

    while let Some(msg) = messages_iter
        .next()
        .await
        .map_err(|e| format!("Failed to get messages: {}", e))?
    {
        let sender = msg.sender();
        messages.push(Message {
            id: msg.id(),
            chat_id,
            from_user_id: sender.as_ref().map(|s| PeerRef::from(&**s).id.bot_api_dialog_id()),
            sender_name: sender.and_then(|s| s.name().map(|n| n.to_string())),
            text: if msg.text().is_empty() {
                None
            } else {
                Some(msg.text().to_string())
            },
            date: msg.date().timestamp(),
            is_outgoing: msg.outgoing(),
            media: extract_media_info(&msg),
        });

        count += 1;
        if count >= limit {
            break;
        }
    }

    tracing::info!(count = messages.len(), chat_id = chat_id, "Messages loaded");
    Ok(messages)
}

/// Mark messages as read in a chat (sends read acknowledgement to Telegram)
#[tauri::command]
pub async fn mark_messages_read(
    account_id: String,
    chat_id: i64,
    max_id: i32,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<(), String> {
    tracing::info!(
        account_id = %account_id,
        chat_id = chat_id,
        max_id = max_id,
        "Marking messages as read"
    );

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

    let chat = resolve_peer(&wrapper, chat_id).await?;

    // Determine peer type and call appropriate ReadHistory
    match &chat {
        grammers_client::types::Peer::Channel(channel) => {
            // Channels and supergroups use channels.ReadHistory
            let ch = &channel.raw;
            let input_channel = grammers_tl_types::enums::InputChannel::Channel(
                grammers_tl_types::types::InputChannel {
                    channel_id: ch.id,
                    access_hash: ch.access_hash.unwrap_or(0),
                }
            );

            wrapper.client.invoke(&grammers_tl_types::functions::channels::ReadHistory {
                channel: input_channel,
                max_id,
            }).await.map_err(|e| format!("Failed to mark channel messages as read: {}", e))?;
        }
        _ => {
            // Users and basic groups use messages.ReadHistory
            let input_peer: grammers_tl_types::enums::InputPeer = PeerRef::from(&chat).into();

            wrapper.client.invoke(&grammers_tl_types::functions::messages::ReadHistory {
                peer: input_peer,
                max_id,
            }).await.map_err(|e| format!("Failed to mark messages as read: {}", e))?;
        }
    }

    tracing::info!(account_id = %account_id, chat_id = chat_id, "Messages marked as read");
    Ok(())
}

/// Search messages in a chat
#[tauri::command]
pub async fn search_messages(
    account_id: String,
    chat_id: i64,
    query: String,
    limit: Option<usize>,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<Message>, String> {
    tracing::info!(
        account_id = %account_id,
        chat_id = chat_id,
        query = %query,
        "Searching messages"
    );

    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

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
    }; // state_guard dropped here

    let chat = resolve_peer(&wrapper, chat_id).await?;

    let limit = limit.unwrap_or(50);
    let mut search_iter = wrapper.client.search_messages(&chat).query(&query);

    let mut messages = Vec::with_capacity(limit);
    let mut count = 0;

    while let Some(msg) = search_iter
        .next()
        .await
        .map_err(|e| format!("Failed to search messages: {}", e))?
    {
        let sender = msg.sender();
        messages.push(Message {
            id: msg.id(),
            chat_id,
            from_user_id: sender.as_ref().map(|s| PeerRef::from(&**s).id.bot_api_dialog_id()),
            sender_name: sender.and_then(|s| s.name().map(|n| n.to_string())),
            text: if msg.text().is_empty() {
                None
            } else {
                Some(msg.text().to_string())
            },
            date: msg.date().timestamp(),
            is_outgoing: msg.outgoing(),
            media: extract_media_info(&msg),
        });

        count += 1;
        if count >= limit {
            break;
        }
    }

    tracing::info!(count = messages.len(), chat_id = chat_id, query = %query, "Search results");
    Ok(messages)
}

/// Send a message to a chat (or to a specific forum topic when topic_id is provided)
#[tauri::command]
pub async fn send_message(
    account_id: String,
    chat_id: i64,
    text: String,
    topic_id: Option<i32>,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<Message, String> {
    tracing::info!(account_id = %account_id, chat_id = chat_id, topic_id = ?topic_id, "Sending message");

    if text.trim().is_empty() {
        return Err("Message text cannot be empty".to_string());
    }

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
    }; // state_guard dropped here

    let chat = resolve_peer(&wrapper, chat_id).await?;

    // For forum topics, use InputMessage with reply_to set to topic_id
    let input_msg = if let Some(tid) = topic_id {
        grammers_client::InputMessage::new().text(&text).reply_to(Some(tid))
    } else {
        grammers_client::InputMessage::new().text(&text)
    };

    let sent_message = wrapper
        .client
        .send_message(&chat, input_msg)
        .await
        .map_err(|e| format!("Failed to send message: {}", e))?;

    tracing::info!(msg_id = sent_message.id(), "Message sent");

    let sender = sent_message.sender();
    Ok(Message {
        id: sent_message.id(),
        chat_id,
        from_user_id: sender.as_ref().map(|s| PeerRef::from(&**s).id.bot_api_dialog_id()),
        sender_name: sender.and_then(|s| s.name().map(|n| n.to_string())),
        text: Some(text),
        date: sent_message.date().timestamp(),
        is_outgoing: true,
        media: extract_media_info(&sent_message),
    })
}
/// Send media to a chat.
///
/// The file content arrives as the RAW IPC body (`InvokeBody::Raw`) instead of
/// a JSON `number[]` — that path serialized every byte as decimal text (~4x the
/// size) and parsed it back on the Rust side. Metadata travels in request
/// headers; `file_name`/`caption` are percent-encoded by the frontend since
/// HTTP header values must be ASCII.
#[tauri::command]
pub async fn send_media(
    request: tauri::ipc::Request<'_>,
    app: tauri::AppHandle,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<Message, String> {
    use percent_encoding::percent_decode_str;

    let tauri::ipc::InvokeBody::Raw(media_bytes) = request.body() else {
        return Err("send_media expects a raw (binary) request body".into());
    };

    let header = |name: &str| -> Option<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
    };
    let decoded = |value: String| -> Result<String, String> {
        percent_decode_str(&value)
            .decode_utf8()
            .map(|s| s.to_string())
            .map_err(|_| "Invalid percent-encoding in header".to_string())
    };

    let account_id = header("x-account-id").ok_or("missing x-account-id header")?;
    let chat_id: i64 = header("x-chat-id")
        .ok_or("missing x-chat-id header")?
        .parse()
        .map_err(|_| "invalid x-chat-id header")?;
    let file_name = decoded(header("x-file-name").ok_or("missing x-file-name header")?)?;
    let mime_type = header("x-mime-type").unwrap_or_else(|| "application/octet-stream".into());
    let caption = header("x-caption").map(decoded).transpose()?;

    tracing::info!(
        account_id = %account_id,
        chat_id = chat_id,
        file_name = %file_name,
        size = media_bytes.len(),
        "Sending media"
    );

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

    let chat = resolve_peer(&wrapper, chat_id).await?;

    // Preserve file extension so grammers can detect media type
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let tmp_path = std::env::temp_dir().join(format!("upload_{}.{}", uuid::Uuid::new_v4(), ext));
    tokio::fs::write(&tmp_path, &media_bytes)
        .await
        .map_err(|e| format!("Failed to write temp file: {}", e))?;

    // Upload the file
    let uploaded_file = wrapper
        .client
        .upload_file(&tmp_path)
        .await
        .map_err(|e| format!("Failed to upload file: {}", e))?;

    // For images: let grammers auto-detect from extension → sends as inputMediaUploadedPhoto
    // For other files: set mime_type explicitly → sends as inputMediaUploadedDocument
    let mut input_msg = grammers_client::InputMessage::new()
        .text(caption.unwrap_or_default())
        .file(uploaded_file);
    if !mime_type.starts_with("image/") {
        input_msg = input_msg.mime_type(&mime_type);
    }

    let sent_message = wrapper
        .client
        .send_message(&chat, input_msg)
        .await
        .map_err(|e| format!("Failed to send media: {}", e))?;

    tracing::info!(msg_id = sent_message.id(), "Media sent");

    // Save a local copy so the frontend can display it immediately (no re-download needed)
    let local_file_path = save_sent_media_locally(&app, chat_id, sent_message.id(), ext, &tmp_path).await;

    // Clean up temp file
    let _ = tokio::fs::remove_file(&tmp_path).await;

    // Build media info with local file path
    let media = sent_message.media().map(|m| {
        let media_type = classify_media_type(&m).to_string();
        let (file_size, mime_type_val) = match &m {
            Media::Document(doc) => (
                Some(doc.size() as u64),
                doc.mime_type().map(|s| s.to_string()),
            ),
            Media::Photo(_) => (None, Some("image/jpeg".to_string())),
            _ => (None, None),
        };
        vec![MediaInfo {
            media_type,
            file_path: local_file_path.clone(),
            file_name: None,
            file_size,
            mime_type: mime_type_val,
        }]
    });

    let sender = sent_message.sender();
    Ok(Message {
        id: sent_message.id(),
        chat_id,
        from_user_id: sender.as_ref().map(|s| PeerRef::from(&**s).id.bot_api_dialog_id()),
        sender_name: sender.and_then(|s| s.name().map(|n| n.to_string())),
        text: if sent_message.text().is_empty() { None } else { Some(sent_message.text().to_string()) },
        date: sent_message.date().timestamp(),
        is_outgoing: true,
        media,
    })
}

/// Forward messages from one chat to another
#[tauri::command]
pub async fn forward_messages(
    account_id: String,
    from_chat_id: i64,
    to_chat_id: i64,
    message_ids: Vec<i32>,
    state: State<'_, Arc<RwLock<AppState>>>,
) -> Result<Vec<Option<i32>>, String> {
    tracing::info!(
        account_id = %account_id,
        from_chat_id = from_chat_id,
        to_chat_id = to_chat_id,
        message_count = message_ids.len(),
        "Forwarding messages"
    );

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

    let from_peer = resolve_peer(&wrapper, from_chat_id).await?;
    let to_peer = resolve_peer(&wrapper, to_chat_id).await?;

    let forwarded = wrapper
        .client
        .forward_messages(PeerRef::from(&to_peer), &message_ids, PeerRef::from(&from_peer))
        .await
        .map_err(|e| format!("Failed to forward messages: {}", e))?;

    let new_ids: Vec<Option<i32>> = forwarded
        .into_iter()
        .map(|opt_msg| opt_msg.map(|msg| msg.id()))
        .collect();

    tracing::info!(
        account_id = %account_id,
        forwarded_count = new_ids.iter().filter(|id| id.is_some()).count(),
        "Messages forwarded"
    );

    Ok(new_ids)
}

/// Save sent media to the local media directory so it can be displayed without re-downloading.
async fn save_sent_media_locally(
    app: &tauri::AppHandle,
    chat_id: i64,
    message_id: i32,
    ext: &str,
    tmp_path: &std::path::Path,
) -> Option<String> {
    use tauri::Manager;
    let app_data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return None,
    };
    let media_dir = app_data_dir.join("media").join(format!("chat_{}", chat_id.unsigned_abs()));
    if tokio::fs::create_dir_all(&media_dir).await.is_err() {
        return None;
    }
    let timestamp = chrono::Utc::now().timestamp();
    let dest = media_dir.join(format!("media_{}_{}.{}", message_id, timestamp, ext));
    if tokio::fs::copy(tmp_path, &dest).await.is_ok() {
        Some(dest.to_string_lossy().to_string())
    } else {
        None
    }
}
