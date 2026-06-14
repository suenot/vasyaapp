# Security & Trust Model

This document describes the trust model of **Vasya** — in particular
`vasya-server`, the agent-native API gateway that runs a Telegram client on your
behalf. Read it before self-hosting the server or issuing agent (`vk_`) keys.

## ⚠️ The server is NOT end-to-end encrypted

`vasya-server` is a real Telegram (MTProto) client. To talk to Telegram it must
hold your **account session keys**. Consequently:

- Anyone with operator/root access to the server host can read those sessions
  and act as the Telegram account.
- Anyone you give a `vk_` agent key to can act as that account, limited to the
  key's scopes and per-account allowlist.

If that trust boundary is unacceptable, **self-host** the server (the desktop
app runs the same engine locally with no remote operator) and keep agent keys
narrow and short-lived.

## What the server protects

- **Sessions encrypted at rest** — Telegram sessions are encrypted with
  `SESSION_MASTER_KEY` (an environment variable on servers; the OS keychain on
  desktop). They persist across restarts but are unreadable without the key.
- **Per-user isolation** — every Telegram account is owned by a user id
  (`local` in embedded mode, the JWT `sub` otherwise). Requests can only reach
  accounts their caller owns; cross-user access returns `403`.
- **Scoped, revocable agent keys** — a `vk_<id>_<hex>` key carries only its
  granted scopes, an optional per-account allowlist, and an optional TTL. Only a
  SHA-256 hash of the secret is stored; the secret is shown **once** at creation;
  keys can be revoked at any time.
- **Least privilege for agents** — agent keys **cannot** mint or manage keys,
  read the audit log, or act outside their scopes/allowlist. Destructive scopes
  (`accounts:delete`, `chats:delete`, `messages:forward`) are separate and never
  auto-granted.
- **Audit log** — every mutating call (human or agent) is appended to
  `data_dir/audit.log`, including the agent key id; readable by humans via
  `GET /api/v1/audit`.
- **Idempotency & rate limiting** — mutations honor an `Idempotency-Key` header
  (safe retries) and agent mutations are rate-limited per key.

## Authentication modes

| Mode | Trust |
| --- | --- |
| **EmbeddedLocal** | Single shared bearer token, bound to `127.0.0.1` in the desktop app — only local processes reach it. |
| **JWT** | HS256 user tokens issued by the sync backend; this server only validates them. Protect `JWT_SECRET` (shared between backend and server). |
| **Agent key (`vk_`)** | Scoped delegate of one user. Treat it like a password for the subset of that user's Telegram activity it can perform. |

## Handling secrets

- `SESSION_MASTER_KEY` and `JWT_SECRET` are critical — leaking either compromises
  every account on the host. Store them in your platform's secret manager, never
  in the repo.
- Per-user provider keys (e.g. a Deepgram STT key) are stored server-side and
  returned only **masked** by the API — but they are not E2E and a host operator
  can read them. Use restricted, rotatable provider keys.
- Agent keys: grant the **minimum** scopes, set an `accountIds` allowlist and a
  `ttlSecs`, and revoke when done.

## Reporting a vulnerability

Please report security issues privately to the maintainer rather than opening a
public issue. Include reproduction steps and the affected component
(`vasya-server`, `vasya-mcp`, desktop app, or `backend`).

---

For the full API surface and how scopes map to endpoints, see
[`docs/api/README.md`](docs/api/README.md).
