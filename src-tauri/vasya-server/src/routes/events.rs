//! Realtime event stream over SSE.
//!
//! This is the minimal HTTP face of the in-process event bus (the bus
//! itself is `ServerContext::events`; GraphQL subscriptions in task #5
//! consume the same bus). Events are filtered to accounts the caller
//! owns; `?account=<id>` narrows to one account.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::Extension;
use serde::Deserialize;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::{Stream, StreamExt};

use crate::auth::{UserId, LOCAL_USER_ID};
use crate::context::ServerContext;

#[derive(Deserialize)]
pub struct EventsQuery {
    pub account: Option<String>,
}

pub async fn sse_events(
    State(ctx): State<Arc<ServerContext>>,
    user: Extension<UserId>,
    Query(filter): Query<EventsQuery>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let user_id = user.0 .0.clone();
    let rx = ctx.events.subscribe();

    let stream = BroadcastStream::new(rx).filter_map(move |item| {
        let event = match item {
            Ok(event) => event,
            // Slow consumer lagged behind the broadcast buffer; skip.
            Err(_) => return None,
        };

        let account = event
            .payload
            .get("accountId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Per-user isolation: only events for accounts the caller owns.
        // Events without accountId go to the embedded local user only.
        let allowed = match &account {
            Some(acc) => ctx.accounts.is_owner(&user_id, acc),
            None => user_id == LOCAL_USER_ID,
        };
        if !allowed {
            return None;
        }

        if let Some(want) = &filter.account {
            if account.as_deref() != Some(want.as_str()) {
                return None;
            }
        }

        let sse = SseEvent::default()
            .event(event.name)
            .json_data(event.payload)
            .ok()?;
        Some(Ok(sse))
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}
