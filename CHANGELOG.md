# Changelog

## [Unreleased]
### Security
- **Hardened the agent/web API after a security review.**
  - *Pagination DoS fixed:* `GET …/messages` and `…/messages/search` now clamp the caller-supplied `limit` (default 50, max 200). Previously an unbounded `?limit=` flowed into `Vec::with_capacity`, so one request could trigger a capacity-overflow panic / OOM.
  - *Path-traversal hardening:* the resolved user id (JWT `sub`) is validated (`[A-Za-z0-9_-]`, ≤128) at the auth choke point before it is ever used as an on-disk path segment for per-user STT/folder state — a crafted `sub` can no longer escape the data dir.
  - *SSE allowlist:* `GET /api/v1/events` now enforces an agent key's per-account allowlist (reject `?account=` outside the list with 403; filter excluded accounts from the unfiltered stream), matching GraphQL subscriptions and the STT handler.
  - *GraphQL DoS guards:* the schema now sets a depth limit (20) and complexity limit (500); previously neither was bounded.
  - *STT language validation:* the transcription `language` (per-request override and persisted setting) is validated (BCP-47-ish `[A-Za-z0-9-]`, ≤16) before being interpolated into the Deepgram request URL, blocking query-parameter injection.
- **Per-user Telegram credentials + admin-gated global default.** Each user can optionally set their own `api_id`/`api_hash` (`PUT /api/v1/telegram/credentials`; opt-in, stored per user, `api_hash` masked on `GET`, cleared with `DELETE`); logins use the caller's own credentials if set, otherwise the server's global default. The global default is now changeable only by a **server admin** via `PUT /api/v1/admin/telegram/credentials`. Admins are config-sourced only (the embedded desktop owner, or env `VASYA_ADMIN_USERS` in JWT mode) — **never settable via the API**, and **agent keys are never admins** and cannot manage credentials at all (credential/admin routes are human-session-only). The server reads its global credentials from the environment (never baked into the server image).

### Server / infra
- **Speech-to-text over the REST API.** `vasya-server` now exposes voice-message transcription (scope `stt:use`) instead of `501` stubs: `GET/PUT /api/v1/stt/settings` (per-user provider + Deepgram key — the key is write-only, stored masked, never logged or echoed back), `POST /api/v1/stt/transcribe` (raw audio upload *or* `{accountId, chatId, messageId}` to transcribe a voice message already in a chat) and `GET /api/v1/stt/models`. On the headless server the default and only working provider is **cloud Deepgram** (bring-your-own-key); **local Whisper is desktop-only** (its `stt-sidecar` binary is excluded from the server image) so selecting it returns a clear `400` and `GET /stt/models` reports `{available:false}` (200, not 501). The Deepgram call + voice-message fetch now live in `vasya-core::stt`, shared by the desktop app and the server.
- **Finer-grained agent-key scopes.** Destructive operations now have their own scopes instead of being bundled with broad ones: `accounts:delete` (log out / delete an account — was `telegram:login`), `chats:delete` (delete/leave a chat — was `chats:write`) and `messages:forward` (was `messages:send`). `telegram:login` now covers login only and `chats:write` group/channel creation only. `GET /api/v1/agent-keys/scopes` now returns `{scope, description}` objects.
  - **Breaking (pre-1.0):** existing `vk_` keys are **not** auto-granted the new destructive scopes — re-issue any key that needs to delete accounts/chats or forward messages.
- **Per-account allowlist on agent keys.** Pass `accountIds` when creating a key (`POST /api/v1/agent-keys`) to restrict it to specific accounts; a `/accounts/{acc}/…` request that already clears its required scope but targets an account outside the list returns 403 `account not in key allowlist`. Omitted/empty = all the owner's accounts (unchanged). The allowlist is reflected in `GET /api/v1/agent-keys`. The allowlist is also enforced for `POST /api/v1/stt/transcribe` when it targets an account via its JSON body.
- **Storage-mode over REST (no longer a 501 stub).** `GET /api/v1/storage-mode` reports the server's fixed storage mode (`{mode:"server", configurable:false, reason}`) and `PUT /api/v1/storage-mode` returns `400` — the server always persists state server-side, so the desktop-only `local`/`remote` toggle does not apply. (Mirrors the STT "structured response instead of 501" pattern.)

## [0.8.0] - 2026-06-12
### Web
- **Vasyapp now runs in the browser.** The same React UI talks to a remote `vasya-server` over HTTP/SSE instead of the in-process Tauri engine. Self-host it from `backend/deploy/`; connect with your server URL + a JWT (email/password against the backend) or an access token. Builds can pre-fill the API origin via the `VITE_VASYA_API_URL` build var.

### Features
- **Date separators** in the message list — Telegram-style "Today / Yesterday / 10 June" day dividers between messages of different calendar days.
- **Rich link previews** — pages shared in chat render a card (site name, title, description) instead of a bare "Link Preview" placeholder. `vasya-server` now extracts the Telegram `webPage` metadata; the desktop backend still shows the minimal preview (parity pending).

### Server / infra
- **Telegram over a SOCKS5 proxy** — set `TELEGRAM_PROXY_URL` (e.g. `socks5://user:pass@127.0.0.1:1080`) to route MTProto through an egress when the host's own IP has Telegram blocked. Unset = direct connection (unchanged). Enabled via grammers' `proxy` feature in `vasya-core`.

## [0.7.7] - 2026-06-10
### Security
- **Telegram sessions are now encrypted at rest** (ChaCha20-Poly1305). The master key lives in the OS keychain (Keychain / Credential Manager), with a 0600 key-file fallback. Existing plaintext sessions are migrated automatically on first launch and the plaintext file is deleted.
- **Per-user account isolation on the sync backend**: data routes accept a personal JWT and an account is bound to the first user who syncs it; other users get 403. Legacy shared-API-key mode still works unless `REQUIRE_USER_AUTH=true`.
- Rate limiting on backend login/register (per-IP); `JWT_SECRET` fails fast if set but shorter than 32 chars.
- Calls are now behind an off-by-default "Experimental" toggle (VoIP audio is not end-to-end encrypted yet).
- Local Whisper is the default STT provider — no audio leaves the device unless you opt into Deepgram.
- Tightened CSP (`object-src`/`frame-src 'none'`, `base-uri`/`form-action 'self'`).

### Features
- **My QR Code**: share your contact via a `t.me` QR like the native Telegram app (sidebar header → QR icon).
- Backend account sign-in/registration in Settings → Storage (issues the JWT used for synced data).

### Performance
- File sending uses raw IPC (binary body) instead of a JSON number array — ~4× smaller bridge payload.

### Fixes
- Login phone field now formats per country (libphonenumber as-you-type) like the native Telegram apps — e.g. `+998 90 829 55 93` instead of the mis-grouped `+9 989 082 95 59 3`.

## [0.7.6] - 2026-06-10
### Security
- Deepgram API key is no longer embedded in the binary — add your own key in Settings → STT (or use local Whisper)
- Validate transcription file paths (must stay inside app data dir)
- Mask phone numbers in logs; remove stale `.bak`/patch files
- Allowlist URL schemes in rendered messages (`http/https/tg/mailto`) — blocks `javascript:`/`data:`/`file:` links
- Narrow asset protocol scope to the media directory; disable devtools and `withGlobalTauri`

### Performance
- Virtualized chat list and message list (`@tanstack/react-virtual`) — long chats no longer render thousands of DOM nodes
- Chat list updates live on incoming messages: preview, unread badge, chat moves to top
- Fixed re-render hotspots: proper Zustand selectors, rAF-throttled call audio levels, batched avatar updates, memoized translations, stable hotkey handlers
- Autoscroll on new messages only when already near the bottom

### Mobile (iOS/Android)
- The app can no longer be dragged down past the top (document rubber-band) — native `WKWebView` bounce disabled + CSS `overscroll-behavior`
- Pinch/double-tap zoom of the UI is disabled (in-app image viewer zoom still works)
- Media auto-download is viewport-scoped: only photos/stickers/voice actually on screen are fetched; scrolling away cancels queued downloads; tap-to-download jumps the queue

## [0.7.5] - 2026-04-02
### Bug Fixes
- Fix settings page on Android — sidebar and content no longer overlap on mobile
- Settings sections now show one at a time with back navigation on small screens

## [0.7.4] - 2026-04-02
### Bug Fixes
- Fix Android keyboard gap — move keyboard height compensation from input padding to container height
- Chat no longer jumps up with empty space above keyboard on Android

## [0.7.3] - 2026-03-16
### Bug Fixes
- Fix Android keyboard squishing entire app — switch from `resizes-content` to `overlays-content`
- Keyboard now overlays content instead of compressing it; input lifts above keyboard via `--keyboard-height` CSS var
- Auto-scroll messages to bottom when keyboard opens on mobile

## [0.7.2] - 2026-03-15
### Bug Fixes
- Fix Android keyboard pushing content up (visualViewport API + CSS var)
- Fix MessageInput safe-area-inset-bottom being overridden

## [0.7.1] - 2026-03-15
### Improvements
- Landing: replaced two-button language switcher with single toggle button

## [0.7.0] - 2026-03-15
### Features
- Create group chats, channels, and supergroups from sidebar
- New Chat button with dropdown menu (group, channel, secret chat)
- Interface scale slider (50%–200%) with live zoom
- Message text size selector (small / medium / large)
- Notification sound toggle (silent notifications)
- Message preview toggle (hide text in notifications)
- Markdown rendering in merged message groups

### Improvements
- Settings controls fully wired to persistent store
- i18n translations for all new features (en/ru)

## [0.6.0] - 2026-03-15
### Features
- Voice & video calls with E2E encryption (DH key exchange)
- Group calls (create, join, leave, mute)
- Message forwarding with chat picker dialog
- Avatar viewer with photo gallery and navigation
- Native OS notifications (macOS, Windows, Linux)
- Folder context menu (Read All, Mute All, Delete)
- Message context menu & multi-select mode
- Markdown rendering in messages
- Chat sorting: unread first in all folders except "All Chats"

### Improvements
- Fullscreen image viewer with zoom, pan, download
- Message grouping (consecutive messages from same sender)
- Theme-aware styling for all new components
- i18n support for all new features (en/ru)
- Sidebar scroll fix
- Call debug logging

## [0.5.0] - 2026-03-10
### Features
- Message bubbles with Telegram-style design
- Unread badges and folder counters
- Enhanced search with global results
- Media UI improvements

## [0.4.0] - 2026-03-05
### Features
- Telegram forum topics support
- Hotkeys and keyboard navigation
- Media attachments and voice recording
- Call placeholders
