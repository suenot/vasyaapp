# vasya-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (stdio) server that
exposes the [vasya](../../) Telegram session host as agent tools. It is **thin by
design**: every tool is one call to the REST API (`vasya-server`), so the API's
auth, scopes, audit log and idempotency apply unchanged.

## Configure

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `VASYA_AGENT_KEY` | ✅ | — | Scoped agent key (`vk_…`) or any bearer the API accepts. Create one via `POST /api/v1/agent-keys`. |
| `VASYA_API_URL` | | `http://127.0.0.1:8787` | Base URL of a running `vasya-server`. |
| `VASYA_DOWNLOAD_DIR` | | `<tmp>/vasya-mcp-downloads` | Where binary tools save files when `output="path"`. |

```jsonc
// e.g. in an MCP client config
{
  "mcpServers": {
    "vasya": {
      "command": "node",
      "args": ["src-tauri/vasya-mcp/dist/index.js"],
      "env": { "VASYA_API_URL": "http://127.0.0.1:8787", "VASYA_AGENT_KEY": "vk_..." }
    }
  }
}
```

Build with `npm install && npm run build` (outputs `dist/index.js`).

## Scopes

Tool availability follows the key's scopes — out-of-scope calls return the API's
`403 Missing scope: <scope>` verbatim as the tool error, so an agent can
self-diagnose which scope to request. Each tool below names the scope it needs.

## Tools (29)

Every tool maps 1:1 to a REST route.

### Accounts & login (`telegram:login`, `accounts:read`)
| Tool | REST |
| --- | --- |
| `list_accounts` | `GET /accounts` |
| `request_login_code` | `POST /telegram/login/code` |
| `verify_login_code` | `POST /telegram/login/verify` |
| `submit_2fa_password` | `POST /telegram/login/password` |
| `delete_account` | `DELETE /accounts/{acc}` |
| `get_account_avatar` | `GET /accounts/{acc}/avatar` |

Login is a flow: `request_login_code` → `verify_login_code` → (if it returns
`password_required`) `submit_2fa_password`.

### Chats (`chats:read`, `chats:write`)
| Tool | REST |
| --- | --- |
| `list_chats` | `GET /accounts/{acc}/chats` |
| `get_contacts` | `GET /accounts/{acc}/contacts` |
| `start_loading_chats` | `POST /accounts/{acc}/chats/load` |
| `create_group` | `POST /accounts/{acc}/groups` |
| `create_channel` | `POST /accounts/{acc}/channels` |
| `delete_chat` | `DELETE /accounts/{acc}/chats/{chat_id}` |
| `get_chat_photo` | `GET /accounts/{acc}/chats/{chat_id}/photo` |
| `get_user_photos` | `GET /accounts/{acc}/chats/{chat_id}/photos` |
| `get_forum_topics` | `GET /accounts/{acc}/chats/{chat_id}/topics` |

### Messages, search & media (`messages:read`, `messages:send`)
| Tool | REST |
| --- | --- |
| `get_messages` | `GET /accounts/{acc}/chats/{chat_id}/messages` |
| `send_message` | `POST /accounts/{acc}/chats/{chat_id}/messages` |
| `forward_messages` | `POST /accounts/{acc}/messages/forward` |
| `mark_messages_read` | `POST /accounts/{acc}/chats/{chat_id}/read` |
| `send_media` | `POST /accounts/{acc}/chats/{chat_id}/media` |
| `download_media` | `GET /accounts/{acc}/chats/{chat_id}/messages/{message_id}/media` |
| `search_messages` | `GET /accounts/{acc}/chats/{chat_id}/messages/search` |
| `search_all_messages` | `GET /accounts/{acc}/messages/search` |
| `global_search` | `GET /accounts/{acc}/search` |

### Folders & tabs (`folders:read`, `folders:write`)
| Tool | REST |
| --- | --- |
| `list_folders` | `GET /accounts/{acc}/folders` |
| `save_folder` | `POST /accounts/{acc}/folders` |
| `delete_folder` | `DELETE /accounts/{acc}/folders/{folder_id}` |
| `get_tabs` | `GET /accounts/{acc}/tabs` |
| `save_tabs` | `PUT /accounts/{acc}/tabs` |

## Media notes

- **`send_media`** — provide either a local `path` (read from disk) or base64
  `data` (then `fileName` is required). Optional `caption` and `mimeType`
  (`image/*` is sent as a photo, anything else as a document). The bytes go in
  the raw request body; metadata rides in percent-encoded `x-file-name` /
  `x-mime-type` / `x-caption` headers — the same contract as the desktop client.
- **`download_media`, `get_account_avatar`, `get_chat_photo`** — return a saved
  file path by default (`output="path"`), or set `output="base64"` to get the
  bytes inline (images come back as a viewable MCP image block). Saved files go
  to `VASYA_DOWNLOAD_DIR`.

## Out of scope

Voice/group calls and STT/transcription are implemented on the REST side but
have no MCP tools yet. Storage-mode is still `501` (desktop-only).
