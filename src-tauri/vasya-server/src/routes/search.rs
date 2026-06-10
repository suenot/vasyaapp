//! Global search endpoints (parity with commands/search.rs).

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use grammers_tl_types as tl;
use serde::Deserialize;

use crate::auth::UserId;
use crate::context::ServerContext;
use crate::dto::{GlobalMessageResult, GlobalSearchResult};
use crate::error::ApiError;
use crate::routes::account_client;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub limit: Option<i32>,
}

fn full_name(first: Option<&str>, last: Option<&str>) -> String {
    let first = first.unwrap_or("");
    let last = last.unwrap_or("");
    if last.is_empty() {
        first.to_string()
    } else {
        format!("{} {}", first, last)
    }
}

/// Global search for users and channels via contacts.Search.
pub(crate) async fn global_search_op(
    ctx: &Arc<ServerContext>,
    user: &UserId,
    account_id: &str,
    q: &str,
    limit: Option<i32>,
) -> Result<Vec<GlobalSearchResult>, ApiError> {
    if q.trim().is_empty() {
        return Ok(Vec::new());
    }

    let wrapper = account_client(ctx, user, account_id).await?;
    let limit = limit.unwrap_or(20);

    let request = tl::functions::contacts::Search { q: q.to_string(), limit };
    let result = wrapper
        .client
        .invoke(&request)
        .await
        .map_err(|e| ApiError::telegram(format!("Failed to perform global search: {e}")))?;

    let mut results = Vec::new();
    match result {
        tl::enums::contacts::Found::Found(found) => {
            for user in &found.users {
                if let tl::enums::User::User(u) = user {
                    results.push(GlobalSearchResult {
                        id: u.id,
                        title: full_name(u.first_name.as_deref(), u.last_name.as_deref()),
                        username: u.username.clone(),
                        result_type: "user".to_string(),
                        subscribers_count: None,
                    });
                }
            }

            for chat in &found.chats {
                match chat {
                    tl::enums::Chat::Channel(ch) => {
                        let result_type = if ch.broadcast { "channel" } else { "group" };
                        results.push(GlobalSearchResult {
                            id: ch.id,
                            title: ch.title.clone(),
                            username: ch.username.clone(),
                            result_type: result_type.to_string(),
                            subscribers_count: ch.participants_count,
                        });
                    }
                    tl::enums::Chat::Chat(ch) => {
                        results.push(GlobalSearchResult {
                            id: ch.id,
                            title: ch.title.clone(),
                            username: None,
                            result_type: "group".to_string(),
                            subscribers_count: Some(ch.participants_count),
                        });
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(results)
}

pub async fn global_search(
    State(ctx): State<Arc<ServerContext>>,
    user: Extension<UserId>,
    Path(account_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<GlobalSearchResult>>, ApiError> {
    Ok(Json(
        global_search_op(&ctx, &user.0, &account_id, &query.q, query.limit).await?,
    ))
}

/// Search messages across all chats via messages.SearchGlobal.
pub(crate) async fn search_all_messages_op(
    ctx: &Arc<ServerContext>,
    user: &UserId,
    account_id: &str,
    q: &str,
    limit: Option<i32>,
) -> Result<Vec<GlobalMessageResult>, ApiError> {
    if q.trim().is_empty() {
        return Ok(Vec::new());
    }

    let wrapper = account_client(ctx, user, account_id).await?;
    let limit = limit.unwrap_or(20);

    let request = tl::functions::messages::SearchGlobal {
        broadcasts_only: false,
        groups_only: false,
        users_only: false,
        folder_id: None,
        q: q.to_string(),
        filter: tl::enums::MessagesFilter::InputMessagesFilterEmpty,
        min_date: 0,
        max_date: 0,
        offset_rate: 0,
        offset_peer: tl::enums::InputPeer::Empty,
        offset_id: 0,
        limit,
    };

    let result = wrapper
        .client
        .invoke(&request)
        .await
        .map_err(|e| ApiError::telegram(format!("Failed to search global messages: {e}")))?;

    let (raw_messages, raw_chats, raw_users) = match result {
        tl::enums::messages::Messages::Messages(m) => (m.messages, m.chats, m.users),
        tl::enums::messages::Messages::Slice(m) => (m.messages, m.chats, m.users),
        tl::enums::messages::Messages::ChannelMessages(m) => (m.messages, m.chats, m.users),
        tl::enums::messages::Messages::NotModified(_) => (Vec::new(), Vec::new(), Vec::new()),
    };

    let mut chat_titles: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    for chat in &raw_chats {
        match chat {
            tl::enums::Chat::Channel(ch) => {
                chat_titles.insert(ch.id, ch.title.clone());
            }
            tl::enums::Chat::Chat(ch) => {
                chat_titles.insert(ch.id, ch.title.clone());
            }
            _ => {}
        }
    }

    let mut user_names: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    for user in &raw_users {
        if let tl::enums::User::User(u) = user {
            user_names.insert(u.id, full_name(u.first_name.as_deref(), u.last_name.as_deref()));
        }
    }

    let mut results = Vec::new();
    for msg in raw_messages {
        if let tl::enums::Message::Message(m) = msg {
            let chat_id = match &m.peer_id {
                tl::enums::Peer::User(u) => u.user_id,
                tl::enums::Peer::Chat(c) => c.chat_id,
                tl::enums::Peer::Channel(c) => c.channel_id,
            };

            let chat_title = chat_titles
                .get(&chat_id)
                .or_else(|| user_names.get(&chat_id))
                .cloned()
                .unwrap_or_else(|| format!("Chat {}", chat_id));

            let sender_name = m.from_id.as_ref().and_then(|p| match p {
                tl::enums::Peer::User(u) => user_names.get(&u.user_id).cloned(),
                tl::enums::Peer::Channel(c) => chat_titles.get(&c.channel_id).cloned(),
                tl::enums::Peer::Chat(c) => chat_titles.get(&c.chat_id).cloned(),
            });

            // Truncate text for preview
            let text = if m.message.is_empty() {
                None
            } else if m.message.chars().count() > 200 {
                let truncated: String = m.message.chars().take(200).collect();
                Some(format!("{}...", truncated))
            } else {
                Some(m.message.clone())
            };

            results.push(GlobalMessageResult {
                message_id: m.id,
                chat_id,
                chat_title,
                sender_name,
                text,
                date: m.date as i64,
            });
        }
    }

    Ok(results)
}

pub async fn search_all_messages(
    State(ctx): State<Arc<ServerContext>>,
    user: Extension<UserId>,
    Path(account_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<GlobalMessageResult>>, ApiError> {
    Ok(Json(
        search_all_messages_op(&ctx, &user.0, &account_id, &query.q, query.limit).await?,
    ))
}
