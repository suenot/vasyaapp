# Vasya API & MCP Guide

`vasya-server` is the agent-native gateway in front of the Vasya Telegram
engine. It exposes the **same capability** as the desktop app over:

- **REST** — `/api/v1/...`
- **GraphQL** — `/api/v1/graphql` (queries, mutations) + WebSocket subscriptions
- **SSE** — `/api/v1/events` (realtime event stream)
- **MCP** — `vasya-mcp`, a stdio Model-Context-Protocol server wrapping the REST API as tools for AI agents

Machine-readable specs are served live:

| Spec | URL |
| --- | --- |
| OpenAPI 3 | `GET /api/v1/openapi.json` |
| GraphQL SDL | `GET /api/v1/graphql/sdl` |
| GraphQL playground | `GET /api/v1/graphql/playground` (when enabled) |
| Health (no auth) | `GET /api/v1/health` |

> ⚠️ **Read [the security model](#7-security-model) before issuing an agent key.**
> The server holds Telegram session keys and is **not end-to-end encrypted** —
> handing out a `vk_` key trusts the server operator with that account's data.

Throughout this guide:

```sh
BASE=https://vasya-api.marketmaker.cc/api/v1   # or http://127.0.0.1:8787/api/v1
TOK="Authorization: Bearer <your-token-or-vk_key>"
```

---

## 1. Auth & access

Every `/api/v1` route except `/health` and `/openapi.json` requires a
`Authorization: Bearer <token>` header. There are three credential types,
resolved by `require_auth` (`vasya-server/src/auth.rs`):

| Type | Who | How it authenticates | Scopes |
| --- | --- | --- | --- |
| **EmbeddedLocal token** | The desktop app's in-process server (single implicit user `local`) | One auto-generated bearer token shown in the app (Settings → Local API server) | All (human) |
| **JWT** | A standalone multi-user server | HS256 user JWT (`sub` = user id). Tokens are **issued by the sync backend**; this server only validates them, so both must share `JWT_SECRET` | All (human) |
| **Agent key (`vk_…`)** | AI agents / integrations | A `vk_<id>_<hex>` bearer; resolves to its **owning user** and carries a scope set + optional per-account allowlist | Only its granted scopes |

A token that does **not** start with `vk_` is treated as a human session
(EmbeddedLocal or JWT depending on how the server was started) and implicitly
holds every scope. A `vk_…` token is an agent key and is checked against the
scope/quota/allowlist policy on every request.

### Agent keys

Agent keys are created by a **human session** (an agent key cannot mint or
manage keys, nor read the audit log).

```sh
# Create a scoped key. The secret is returned ONCE — store it now.
curl -s -X POST -H "$TOK" -H 'content-type: application/json' \
  -d '{"name":"my-bot","scopes":["chats:read","messages:read","messages:send"],
       "accountIds":["<account-uuid>"], "ttlSecs": 2592000}' \
  $BASE/agent-keys
# -> {"id":"ak…","secret":"vk_ak…_…","scopes":[…],"accountIds":[…],"expiresAt":…}

# List your keys (hashes never returned)
curl -s -H "$TOK" $BASE/agent-keys

# Revoke a key
curl -s -X DELETE -H "$TOK" $BASE/agent-keys/<key-id>

# The canonical scope list with descriptions (matches the table below)
curl -s -H "$TOK" $BASE/agent-keys/scopes
```

Key creation fields:

- `name` — label.
- `scopes` — required, non-empty; each must be one of the scopes below.
- `accountIds` — optional **per-account allowlist**. Omitted/empty = all of the
  owner's accounts. When set, any request that targets an account outside the
  list returns `403 account not in key allowlist` — even if the scope passes.
- `ttlSecs` — optional time-to-live; the key expires after this many seconds.

> **Breaking (pre-1.0):** the destructive scopes `accounts:delete`,
> `chats:delete` and `messages:forward` are **not** auto-granted to existing
> keys — re-issue keys that need them.

### Scopes

Authoritative source: `ALL_SCOPES` / `SCOPE_DESCRIPTIONS` in
`vasya-server/src/agent_keys.rs`; the route→scope mapping is `required_scope`
in `vasya-server/src/policy.rs`.

| Scope | Grants |
| --- | --- |
| `accounts:read` | List accounts; read account/avatar metadata; read storage-mode |
| `accounts:delete` | Log out / delete an account (`DELETE /accounts/{acc}`) |
| `telegram:login` | Log in a Telegram account (login endpoints only) + read/set API credentials |
| `chats:read` | List chats, contacts, topics, global search and chat photos; trigger chat loading |
| `chats:write` | Create groups and channels |
| `chats:delete` | Delete/leave a chat (`DELETE /accounts/{acc}/chats/{chat_id}`) |
| `messages:read` | Read messages and message media; search messages |
| `messages:send` | Send messages and media; mark messages read |
| `messages:forward` | Forward messages (`POST /accounts/{acc}/messages/forward`) |
| `folders:read` | Read folders and tabs |
| `folders:write` | Create, update and delete folders and tabs |
| `events:read` | Subscribe to the realtime event stream (SSE + GraphQL subscriptions) |
| `calls:use` | Use 1:1 voice/video and group calls (signaling/control) |
| `stt:use` | Use speech-to-text (`/stt/*`) |

Human sessions hold all scopes implicitly. GraphQL enforces the **same** scopes
per resolver as the REST twin (cross-checked by the `graphql_scopes_mirror_rest`
test), so the two transports cannot drift apart.

---

## 2. REST quickstart

A trailing slash on `BASE` is not needed. `{acc}` is an account UUID.

```sh
# Log in (3-step flow): request a code, verify it, then 2FA if required
curl -s -X POST -H "$TOK" -H 'content-type: application/json' \
  -d '{"phone":"+15551234567"}' $BASE/telegram/login/code          # -> {accountId,…}
curl -s -X POST -H "$TOK" -H 'content-type: application/json' \
  -d '{"accountId":"<acc>","code":"12345"}' $BASE/telegram/login/verify
# If that returns {"status":"password_required"}:
curl -s -X POST -H "$TOK" -H 'content-type: application/json' \
  -d '{"accountId":"<acc>","password":"<2fa>"}' $BASE/telegram/login/password

# Accounts & chats
curl -s -H "$TOK" $BASE/accounts
curl -s -X POST -H "$TOK" $BASE/accounts/<acc>/chats/load        # kick off loading
curl -s -H "$TOK" $BASE/accounts/<acc>/chats

# Messages
curl -s -H "$TOK" "$BASE/accounts/<acc>/chats/<chatId>/messages?limit=50"
curl -s -X POST -H "$TOK" -H 'content-type: application/json' \
  -d '{"text":"hello from the API"}' $BASE/accounts/<acc>/chats/<chatId>/messages

# Media: upload raw bytes (metadata in headers); download bytes out
curl -s -X POST -H "$TOK" -H 'content-type: application/octet-stream' \
  -H 'x-file-name: pic.jpg' -H 'x-mime-type: image/jpeg' \
  --data-binary @pic.jpg $BASE/accounts/<acc>/chats/<chatId>/media
curl -s -H "$TOK" -o out.bin \
  $BASE/accounts/<acc>/chats/<chatId>/messages/<msgId>/media

# Speech-to-text (cloud Deepgram, bring-your-own-key)
curl -s -X PUT -H "$TOK" -H 'content-type: application/json' \
  -d '{"deepgramApiKey":"<dg-key>","language":"en"}' $BASE/stt/settings
curl -s -X POST -H "$TOK" -H 'content-type: application/json' \
  -d '{"accountId":"<acc>","chatId":<id>,"messageId":<id>}' $BASE/stt/transcribe

# Realtime (Server-Sent Events) — see §4
curl -N -H "$TOK" "$BASE/events?account=<acc>"
```

Cross-cutting REST conventions:

- **Idempotency** — send an `Idempotency-Key: <uuid>` header on any mutating
  call; a retry with the same key replays the original response
  (`idempotency-replayed: true`) instead of re-running.
- **Rate limits** — agent mutations are rate-limited per key; on `429` honor the
  `Retry-After` header.
- **Errors** — non-2xx responses are JSON `{"error":"…"}` with the matching HTTP
  status (`400` bad request, `401` unauthorized, `403` scope/allowlist, `404`
  not found, `429` rate limited, `501` desktop-only — see §8).

---

## 3. GraphQL

One endpoint for queries and mutations; subscriptions over WebSocket.

```sh
# Query
curl -s -H "$TOK" -H 'content-type: application/json' \
  -d '{"query":"{ accounts { accountId phone } }"}' $BASE/graphql

# Mutation
curl -s -H "$TOK" -H 'content-type: application/json' \
  -d '{"query":"mutation { sendMessage(accountId:\"<acc>\", chatId:<id>, text:\"hi\") { id date } }"}' \
  $BASE/graphql
```

- **Agent keys may use GraphQL.** Each resolver enforces the same scope its REST
  twin requires, plus the per-account allowlist. A missing scope / allowlist
  violation comes back as a normal GraphQL error (HTTP 200, `errors[]`,
  `extensions.code = "FORBIDDEN"`). For a subscription it is the first and only
  item the stream yields before closing.
- The full schema is at `GET /api/v1/graphql/sdl`; explore interactively at
  `/api/v1/graphql/playground` when enabled.

---

## 4. Realtime (SSE + GraphQL subscriptions)

Two transports over the **same event bus**; both require `events:read`.

**SSE** — `GET /api/v1/events?account=<acc>` streams events as they happen.

**GraphQL subscriptions** (WebSocket at `/api/v1/graphql/ws`) — authenticate in
the `connection_init` payload (`{"Authorization":"Bearer <token-or-vk_key>"}`),
then subscribe:

```graphql
subscription { messageReceived(accountId: "<acc>") { event } }
```

Available subscriptions: `messageReceived`, `messageEdited`, `messageDeleted`,
`chatUpdated`, `chatsLoadingProgress`, `connectionStatus`, `callEvent`,
`groupCallEvent`, `sttProgress`.

**Event names/payloads are the contract** (e.g. `telegram:new-message`,
`chat-loaded`, `connection-status`) and are shared with the desktop app — do not
assume they change between transports.

---

## 5. MCP (`vasya-mcp`)

`vasya-mcp` is a stdio MCP server that exposes the REST API as agent tools.

### Configuration

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `VASYA_API_URL` | No | `http://127.0.0.1:8787` | Base URL of the vasya-api host (trailing `/` stripped; calls hit `${VASYA_API_URL}/api/v1…`) |
| `VASYA_AGENT_KEY` | **Yes** | — (exits if unset) | Bearer sent as `Authorization`; normally a scoped `vk_…` key |
| `VASYA_DOWNLOAD_DIR` | No | `${tmpdir}/vasya-mcp-downloads` | Where binary tools write files when `output='path'` (default) |

All mutating tools attach a random `Idempotency-Key` so retries are safe.

Example MCP client config:

```json
{
  "mcpServers": {
    "vasya": {
      "command": "node",
      "args": ["/path/to/vasya-mcp/dist/index.js"],
      "env": { "VASYA_API_URL": "https://vasya-api.marketmaker.cc",
               "VASYA_AGENT_KEY": "vk_…" }
    }
  }
}
```

### Tool reference (29 tools)

Each tool's required scope is the scope its REST endpoint maps to (§1). An agent
key must hold that scope **and** be allowed to reach the target account.

| Tool | Purpose | Key args | Scope |
| --- | --- | --- | --- |
| `list_accounts` | List connected accounts | — | `accounts:read` |
| `list_chats` | List an account's chats (`live` forces refresh) | `accountId`, `live?` | `chats:read` |
| `get_contacts` | List contacts (user chats) | `accountId` | `chats:read` |
| `get_messages` | Read messages (newest first; paginate `offsetId`) | `accountId`, `chatId`, `limit?`, `offsetId?`, `topicId?` | `messages:read` |
| `send_message` | Send a text message | `accountId`, `chatId`, `text`, `topicId?` | `messages:send` |
| `forward_messages` | Forward messages between chats | `accountId`, `fromChatId`, `toChatId`, `messageIds[]` | `messages:forward` |
| `mark_messages_read` | Mark read up to a message id | `accountId`, `chatId`, `maxId` | `messages:send` |
| `search_messages` | Search within one chat | `accountId`, `chatId`, `query`, `limit?` | `messages:read` |
| `search_all_messages` | Search across an account's chats | `accountId`, `query`, `limit?` | `messages:read` |
| `global_search` | Search Telegram globally (users/groups/channels) | `accountId`, `query`, `limit?` | `chats:read` |
| `get_forum_topics` | List forum-supergroup topics | `accountId`, `chatId` | `chats:read` |
| `list_folders` | List UI folders | `accountId` | `folders:read` |
| `start_loading_chats` | Background-refresh the chat list | `accountId` | `chats:read` |
| `request_login_code` | Start login; returns new `accountId` | `phone` | `telegram:login` |
| `verify_login_code` | Submit login code (may need 2FA) | `accountId`, `code` | `telegram:login` |
| `submit_2fa_password` | Finish a `password_required` login | `accountId`, `password` | `telegram:login` |
| `delete_account` | Log out + remove an account (irreversible) | `accountId` | `accounts:delete` |
| `get_account_avatar` | Fetch the account owner's photo | `accountId`, `output?` | `accounts:read` |
| `create_group` | Create a basic group with members | `accountId`, `title`, `userIds[]` | `chats:write` |
| `create_channel` | Create a channel / supergroup | `accountId`, `title`, `about?`, `isMegagroup?` | `chats:write` |
| `delete_chat` | Delete/leave a chat | `accountId`, `chatId` | `chats:delete` |
| `get_chat_photo` | Fetch a chat/user's photo | `accountId`, `chatId`, `output?` | `chats:read` |
| `get_user_photos` | List a chat/user's profile photos | `accountId`, `chatId` | `chats:read` |
| `save_folder` | Create/update a UI folder (upsert) | `accountId`, `id`, `name`, `sortOrder`, … | `folders:write` |
| `delete_folder` | Delete a UI folder | `accountId`, `folderId` | `folders:write` |
| `get_tabs` | List UI tabs | `accountId` | `folders:read` |
| `save_tabs` | Replace the full set of UI tabs | `accountId`, `tabs[]` | `folders:write` |
| `send_media` | Upload + send a file (`path` or base64 `data`) | `accountId`, `chatId`, `path?`/`data?`, `fileName?`, `caption?`, `mimeType?` | `messages:send` |
| `download_media` | Download a message's media | `accountId`, `chatId`, `messageId`, `output?` | `messages:read` |

Binary tools (`get_account_avatar`, `get_chat_photo`, `download_media`) save to
`VASYA_DOWNLOAD_DIR` when `output='path'` (default) or return base64/image blocks
when `output='base64'`. Login is the three-step flow
`request_login_code → verify_login_code → submit_2fa_password`. There are no MCP
tools yet for calls, STT or realtime subscriptions (those are REST/GraphQL only).

---

## 6. Per-user isolation

Every account is owned by a user id (`local` in EmbeddedLocal mode, the JWT
`sub` otherwise). A request can only touch accounts its caller owns; an agent
key additionally narrows that to its allowlist. Cross-user access returns `403`.

---

## 7. Security model

**The server is NOT end-to-end encrypted.** It runs a real Telegram (MTProto)
client on your behalf and therefore holds your **Telegram session keys**.
Anyone with operator access to the server host — and anyone you give a `vk_` key
— can act as that Telegram account within the granted scopes. Self-host if that
trust boundary matters to you.

What the server does protect:

- **Sessions encrypted at rest.** Telegram sessions are encrypted with
  `SESSION_MASTER_KEY` (env on servers; OS keychain on desktop). They survive
  restarts but are unreadable without the key.
- **Per-user isolation.** Accounts are owned per user id; no cross-user access.
- **Scoped, revocable agent keys.** `vk_` keys hold only granted scopes, an
  optional per-account allowlist and an optional TTL; only a SHA-256 hash of the
  secret is stored, the secret is shown once, and keys can be revoked.
- **Audit log.** Every mutating call (user or agent) is appended to
  `data_dir/audit.log`; readable by humans via `GET /api/v1/audit` (agent keys
  cannot read it).
- **Idempotency & rate limits.** Mutations support `Idempotency-Key` replay and
  agent keys are rate-limited per key.

What an agent key **can** do: anything its scopes + allowlist permit, on its
owner's accounts. What it **cannot** do: manage keys, read the audit log, use
GraphQL/REST outside its scopes, or reach accounts outside its allowlist.

See [`SECURITY.md`](../../SECURITY.md) for the trust model in full.

---

## 8. Coverage & limitations

Implemented over REST + GraphQL: accounts, chats, contacts, messages, media,
search, forum topics, folders/tabs, realtime events, 1:1 call **signaling**,
group calls (full), and speech-to-text (cloud Deepgram).

Deliberately not available on a headless server (not "missing"):

| Surface | Behavior | Why |
| --- | --- | --- |
| 1:1 call **audio** (`/calls/volume`, `/calls/mute`) | `501` | Real-time capture/playback runs in the desktop VoIP sidecar, not the server |
| **Local Whisper** STT | `400` (and `GET /stt/models` → `{available:false}`, 200) | Needs the desktop-only `stt-sidecar` binary; use the cloud Deepgram provider |
| **storage-mode** `PUT` | `400`; `GET` → `{mode:"server",configurable:false}` | The server always persists state server-side; `local`/`remote` is a desktop toggle |

These return structured, documented responses (not silent failures) so
integrators aren't surprised.
