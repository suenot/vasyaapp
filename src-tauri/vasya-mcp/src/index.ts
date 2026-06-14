#!/usr/bin/env node
/**
 * vasya-mcp — MCP (stdio) server over the vasya-api Telegram session host.
 *
 * Thin by design: every tool is one REST call. Configure with:
 *   VASYA_API_URL   base URL (default http://127.0.0.1:8787)
 *   VASYA_AGENT_KEY scoped agent key (vk_...) or any bearer the API accepts
 *
 * Tool availability follows the key's scopes — out-of-scope calls return
 * the API's 403 with the missing scope named, so agents can self-diagnose.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const BASE_URL = (process.env.VASYA_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const AGENT_KEY = process.env.VASYA_AGENT_KEY;
if (!AGENT_KEY) {
  console.error("VASYA_AGENT_KEY is required (create one via POST /api/v1/agent-keys)");
  process.exit(1);
}

// Where download_media / get_*_avatar / get_chat_photo write files when the
// caller asks for a path (the default) instead of inline base64.
const DOWNLOAD_DIR = process.env.VASYA_DOWNLOAD_DIR ?? join(tmpdir(), "vasya-mcp-downloads");

async function api(
  method: string,
  path: string,
  body?: unknown,
  idempotent = false,
): Promise<string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${AGENT_KEY}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  // Safe retries for mutations: the server replays on duplicate keys.
  if (idempotent) headers["Idempotency-Key"] = randomUUID();

  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `${method} ${path} -> ${response.status}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}: ${text}`,
    );
  }
  return text.length > 0 ? text : JSON.stringify({ ok: true });
}

const asText = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Build the API error message exactly like `api()` does (status + body). */
function apiError(method: string, path: string, response: Response, body: string): Error {
  const retryAfter = response.headers.get("retry-after");
  return new Error(
    `${method} ${path} -> ${response.status}${retryAfter ? ` (retry after ${retryAfter}s)` : ""}: ${body}`,
  );
}

/** Pick a file extension for a downloaded blob from its content-type. */
function extFromContentType(contentType: string): string {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const known: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "video/mp4": "mp4",
    "application/octet-stream": "bin",
  };
  if (known[base]) return known[base];
  const sub = base.split("/")[1];
  return sub ? sub.replace(/[^a-z0-9]+/g, "") || "bin" : "bin";
}

/**
 * GET a binary endpoint (media/avatars/photos) and return it either as a saved
 * file path (default — keeps the agent context small) or inline base64. Images
 * requested as base64 come back as an MCP image block the model can view.
 */
async function fetchBinary(path: string, mode: "path" | "base64", name: string) {
  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${AGENT_KEY}` },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw apiError("GET", path, response, buffer.toString("utf8"));
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";

  if (mode === "base64") {
    const data = buffer.toString("base64");
    if (contentType.split(";")[0]?.trim().startsWith("image/")) {
      return {
        content: [
          { type: "image" as const, data, mimeType: contentType.split(";")[0].trim() },
        ],
      };
    }
    return asText(JSON.stringify({ contentType, bytes: buffer.length, base64: data }));
  }

  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const dest = join(DOWNLOAD_DIR, `${name}_${randomUUID()}.${extFromContentType(contentType)}`);
  await writeFile(dest, buffer);
  return asText(JSON.stringify({ path: dest, contentType, bytes: buffer.length }));
}

/** Percent-encode a header value the way the server's `send_media` decodes it. */
const encodeHeader = (value: string) => encodeURIComponent(value);

/**
 * POST raw file bytes to the media endpoint: body is the bytes, metadata rides
 * in percent-encoded `x-*` headers (mirrors `src/transport/http.ts` sendMedia).
 */
async function sendMedia(
  accountId: string,
  chatId: number,
  bytes: Buffer,
  meta: { fileName: string; mimeType?: string; caption?: string },
): Promise<string> {
  const path = `/accounts/${accountId}/chats/${chatId}/media`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${AGENT_KEY}`,
    "content-type": "application/octet-stream",
    "Idempotency-Key": randomUUID(),
    "x-file-name": encodeHeader(meta.fileName),
  };
  if (meta.mimeType) headers["x-mime-type"] = meta.mimeType;
  if (meta.caption !== undefined) headers["x-caption"] = encodeHeader(meta.caption);

  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    method: "POST",
    headers,
    body: bytes as unknown as BodyInit,
  });
  const text = await response.text();
  if (!response.ok) throw apiError("POST", path, response, text);
  return text.length > 0 ? text : JSON.stringify({ ok: true });
}

const server = new McpServer({ name: "vasya-mcp", version: "0.2.0" });

const accountId = z.string().describe("Telegram account id (from list_accounts)");
const chatId = z.coerce.number().int().describe("Chat id (bot-api format, from list_chats)");
// How binary endpoints (avatars, photos, media) return their bytes.
const binaryOutput = z
  .enum(["path", "base64"])
  .default("path")
  .describe("'path' saves to disk and returns the path (default); 'base64' returns bytes inline");

server.tool(
  "list_accounts",
  "List the connected Telegram accounts (id, phone, connected). Account ids are required by every other tool.",
  {},
  async () => asText(await api("GET", "/accounts")),
);

server.tool(
  "list_chats",
  "List an account's chats (id, title, unread count, type user/group/channel, last message preview). Set live=true to force a fresh fetch from Telegram instead of the cache.",
  { accountId, live: z.boolean().optional().describe("Bypass the cache (slower)") },
  async ({ accountId, live }) =>
    asText(await api("GET", `/accounts/${accountId}/chats${live ? "?source=live" : ""}`)),
);

server.tool(
  "get_contacts",
  "List contacts: chats of type 'user' for an account.",
  { accountId },
  async ({ accountId }) => asText(await api("GET", `/accounts/${accountId}/contacts`)),
);

server.tool(
  "get_messages",
  "Read messages from a chat, newest first. Use offsetId for pagination (pass the lowest message id from the previous page). topicId reads one forum topic.",
  {
    accountId,
    chatId,
    limit: z.coerce.number().int().optional().describe("Max messages (default 50)"),
    offsetId: z.coerce.number().int().optional().describe("Only messages older than this id"),
    topicId: z.coerce.number().int().optional().describe("Forum topic id (from get_forum_topics)"),
  },
  async ({ accountId, chatId, limit, offsetId, topicId }) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (offsetId !== undefined) params.set("offset_id", String(offsetId));
    if (topicId !== undefined) params.set("topic_id", String(topicId));
    const qs = params.size > 0 ? `?${params}` : "";
    return asText(await api("GET", `/accounts/${accountId}/chats/${chatId}/messages${qs}`));
  },
);

server.tool(
  "send_message",
  "Send a text message to a chat (optionally into a forum topic). Returns the sent message. Rate-limited per account — on 429, wait the indicated seconds.",
  {
    accountId,
    chatId,
    text: z.string().min(1).describe("Message text"),
    topicId: z.coerce.number().int().optional().describe("Forum topic id"),
  },
  async ({ accountId, chatId, text, topicId }) =>
    asText(
      await api("POST", `/accounts/${accountId}/chats/${chatId}/messages`, { text, topicId }, true),
    ),
);

server.tool(
  "forward_messages",
  "Forward messages between chats. Returns the new message ids (null entries failed).",
  {
    accountId,
    fromChatId: z.coerce.number().int().describe("Source chat id"),
    toChatId: z.coerce.number().int().describe("Destination chat id"),
    messageIds: z.array(z.coerce.number().int()).min(1).describe("Message ids to forward"),
  },
  async ({ accountId, fromChatId, toChatId, messageIds }) =>
    asText(
      await api(
        "POST",
        `/accounts/${accountId}/messages/forward`,
        { fromChatId, toChatId, messageIds },
        true,
      ),
    ),
);

server.tool(
  "mark_messages_read",
  "Mark messages as read in a chat up to a message id (sends the read receipt to Telegram).",
  { accountId, chatId, maxId: z.coerce.number().int().describe("Highest message id to mark read") },
  async ({ accountId, chatId, maxId }) =>
    asText(await api("POST", `/accounts/${accountId}/chats/${chatId}/read`, { maxId }, true)),
);

server.tool(
  "search_messages",
  "Full-text search within one chat.",
  { accountId, chatId, query: z.string().min(1), limit: z.coerce.number().int().optional() },
  async ({ accountId, chatId, query, limit }) => {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set("limit", String(limit));
    return asText(
      await api("GET", `/accounts/${accountId}/chats/${chatId}/messages/search?${params}`),
    );
  },
);

server.tool(
  "search_all_messages",
  "Full-text search across all chats of an account. Returns message previews with chat titles.",
  { accountId, query: z.string().min(1), limit: z.coerce.number().int().optional() },
  async ({ accountId, query, limit }) => {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set("limit", String(limit));
    return asText(await api("GET", `/accounts/${accountId}/messages/search?${params}`));
  },
);

server.tool(
  "global_search",
  "Search Telegram globally for users, groups and channels by name/username (not message content).",
  { accountId, query: z.string().min(1), limit: z.coerce.number().int().optional() },
  async ({ accountId, query, limit }) => {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set("limit", String(limit));
    return asText(await api("GET", `/accounts/${accountId}/search?${params}`));
  },
);

server.tool(
  "get_forum_topics",
  "List the topics of a forum supergroup (chats with isForum=true).",
  { accountId, chatId },
  async ({ accountId, chatId }) =>
    asText(await api("GET", `/accounts/${accountId}/chats/${chatId}/topics`)),
);

server.tool(
  "list_folders",
  "List the account's UI folders (chat organization).",
  { accountId },
  async ({ accountId }) => asText(await api("GET", `/accounts/${accountId}/folders`)),
);

server.tool(
  "start_loading_chats",
  "Trigger a background refresh of the chat list from Telegram. Results land in the cache used by list_chats; poll list_chats afterwards.",
  { accountId },
  async ({ accountId }) => asText(await api("POST", `/accounts/${accountId}/chats/load`)),
);

// --- Auth / login (scope: telegram:login) -----------------------------------
// Three-step flow: request_login_code returns an accountId, then
// verify_login_code with the SMS/app code; if it reports password_required,
// finish with submit_2fa_password.

server.tool(
  "request_login_code",
  "Start a Telegram login: send a code to the phone and return a new accountId (scope: telegram:login). Continue with verify_login_code using that accountId. Requires server-side API credentials.",
  { phone: z.string().min(1).describe("Phone number in international format, e.g. +12025550123") },
  async ({ phone }) => asText(await api("POST", "/telegram/login/code", { phone }, true)),
);

server.tool(
  "verify_login_code",
  "Submit the login code Telegram sent. Returns {status:'authorized', user} on success or {status:'password_required'} if the account has 2FA — then call submit_2fa_password (scope: telegram:login).",
  {
    accountId: z.string().describe("accountId from request_login_code"),
    code: z.string().min(1).describe("The login code from SMS/Telegram app"),
  },
  async ({ accountId, code }) =>
    asText(await api("POST", "/telegram/login/verify", { accountId, code }, true)),
);

server.tool(
  "submit_2fa_password",
  "Finish a login that returned password_required by submitting the account's 2FA (cloud) password (scope: telegram:login).",
  {
    accountId: z.string().describe("accountId from request_login_code"),
    password: z.string().min(1).describe("The 2FA cloud password"),
  },
  async ({ accountId, password }) =>
    asText(await api("POST", "/telegram/login/password", { accountId, password }, true)),
);

// --- Accounts ----------------------------------------------------------------

server.tool(
  "delete_account",
  "Log out and remove a connected account from the server (scope: accounts:delete). Irreversible — the session is dropped; logging back in needs the code flow again.",
  { accountId },
  async ({ accountId }) => asText(await api("DELETE", `/accounts/${accountId}`, undefined, true)),
);

server.tool(
  "get_account_avatar",
  "Fetch the account owner's own profile photo (scope: accounts:read). Returns a saved file path by default, or set output='base64' to get the image inline.",
  { accountId, output: binaryOutput },
  async ({ accountId, output }) =>
    fetchBinary(`/accounts/${accountId}/avatar`, output, `avatar_${accountId}`),
);

// --- Chats -------------------------------------------------------------------

server.tool(
  "create_group",
  "Create a basic Telegram group with the given title and initial members (scope: chats:write). Returns the new chat id (bot-api format).",
  {
    accountId,
    title: z.string().min(1).describe("Group title"),
    userIds: z
      .array(z.coerce.number().int())
      .min(1)
      .describe("User ids to add (from get_contacts/global_search)"),
  },
  async ({ accountId, title, userIds }) =>
    asText(await api("POST", `/accounts/${accountId}/groups`, { title, userIds }, true)),
);

server.tool(
  "create_channel",
  "Create a broadcast channel, or a supergroup when isMegagroup=true (scope: chats:write). Returns the new chat id (bot-api format).",
  {
    accountId,
    title: z.string().min(1).describe("Channel/supergroup title"),
    about: z.string().optional().describe("Description (optional)"),
    isMegagroup: z
      .boolean()
      .optional()
      .describe("true → supergroup, false/omitted → broadcast channel"),
  },
  async ({ accountId, title, about, isMegagroup }) =>
    asText(
      await api(
        "POST",
        `/accounts/${accountId}/channels`,
        { title, about, isMegagroup },
        true,
      ),
    ),
);

server.tool(
  "delete_chat",
  "Delete/leave a chat (scope: chats:write). Channels/supergroups are left, basic groups are left, and user chats have their history cleared.",
  { accountId, chatId },
  async ({ accountId, chatId }) =>
    asText(await api("DELETE", `/accounts/${accountId}/chats/${chatId}`, undefined, true)),
);

server.tool(
  "get_chat_photo",
  "Fetch a chat/user's current profile photo (scope: chats:read). Returns a saved file path by default, or set output='base64' for the image inline.",
  { accountId, chatId, output: binaryOutput },
  async ({ accountId, chatId, output }) =>
    fetchBinary(`/accounts/${accountId}/chats/${chatId}/photo`, output, `chat_${chatId}`),
);

server.tool(
  "get_user_photos",
  "List all of a chat/user's profile photos (scope: chats:read). Returns {count, urls}; each url is an API path you can fetch with get_account_avatar-style auth.",
  { accountId, chatId },
  async ({ accountId, chatId }) =>
    asText(await api("GET", `/accounts/${accountId}/chats/${chatId}/photos`)),
);

// --- Folders (write) ---------------------------------------------------------

server.tool(
  "save_folder",
  "Create or update a UI folder (upsert by id; scope: folders:write). Folders organize the chat list by type and explicit include/exclude lists.",
  {
    accountId,
    id: z.string().min(1).describe("Folder id (stable key; reuse to update)"),
    name: z.string().min(1).describe("Folder display name"),
    icon: z.string().optional().describe("Optional icon name/emoji"),
    includedChatTypes: z
      .array(z.string())
      .optional()
      .describe("Chat types to include, e.g. ['user','group','channel']"),
    excludedChatTypes: z.array(z.string()).optional().describe("Chat types to exclude"),
    includedChatIds: z.array(z.coerce.number().int()).optional().describe("Specific chat ids to include"),
    excludedChatIds: z.array(z.coerce.number().int()).optional().describe("Specific chat ids to exclude"),
    sortOrder: z.coerce.number().int().min(0).max(10000).describe("Sort position (0–10000)"),
  },
  async ({
    accountId,
    id,
    name,
    icon,
    includedChatTypes,
    excludedChatTypes,
    includedChatIds,
    excludedChatIds,
    sortOrder,
  }) =>
    asText(
      await api(
        "POST",
        `/accounts/${accountId}/folders`,
        {
          // FolderRecord is snake_case on the wire (no camelCase rename).
          id,
          account_id: accountId,
          name,
          icon: icon ?? null,
          included_chat_types: includedChatTypes ?? [],
          excluded_chat_types: excludedChatTypes ?? [],
          included_chat_ids: includedChatIds ?? [],
          excluded_chat_ids: excludedChatIds ?? [],
          sort_order: sortOrder,
        },
        true,
      ),
    ),
);

server.tool(
  "delete_folder",
  "Delete a UI folder by id (scope: folders:write).",
  { accountId, folderId: z.string().min(1).describe("Folder id to delete") },
  async ({ accountId, folderId }) =>
    asText(await api("DELETE", `/accounts/${accountId}/folders/${folderId}`, undefined, true)),
);

// --- Tabs --------------------------------------------------------------------

server.tool(
  "get_tabs",
  "List the account's UI tabs (visibility + order; scope: folders:read).",
  { accountId },
  async ({ accountId }) => asText(await api("GET", `/accounts/${accountId}/tabs`)),
);

server.tool(
  "save_tabs",
  "Replace the account's full set of UI tabs (scope: folders:write). Send the complete list; it overwrites what's stored.",
  {
    accountId,
    tabs: z
      .array(
        z.object({
          id: z.string().min(1).describe("Tab id"),
          visible: z.boolean().describe("Whether the tab is shown"),
          sortOrder: z.coerce.number().int().min(0).max(10000).describe("Sort position (0–10000)"),
        }),
      )
      .describe("The complete ordered list of tabs"),
  },
  async ({ accountId, tabs }) =>
    asText(
      await api(
        "PUT",
        `/accounts/${accountId}/tabs`,
        // TabRecord is snake_case on the wire.
        tabs.map((t) => ({
          id: t.id,
          account_id: accountId,
          visible: t.visible,
          sort_order: t.sortOrder,
        })),
        true,
      ),
    ),
);

// --- Media -------------------------------------------------------------------

server.tool(
  "send_media",
  "Upload and send a file to a chat (scope: messages:send). Provide either a local 'path' or base64 'data' (then 'fileName' is required). Optional caption and mimeType. Returns the sent message.",
  {
    accountId,
    chatId,
    path: z.string().optional().describe("Local file path to read and send"),
    data: z.string().optional().describe("Base64 file contents (alternative to path)"),
    fileName: z
      .string()
      .optional()
      .describe("File name; required with 'data', defaults to path's basename"),
    caption: z.string().optional().describe("Optional caption text"),
    mimeType: z
      .string()
      .optional()
      .describe("MIME type; image/* sends as a photo, otherwise as a document"),
  },
  async ({ accountId, chatId, path, data, fileName, caption, mimeType }) => {
    let bytes: Buffer;
    let name: string;
    if (path !== undefined) {
      bytes = await readFile(path);
      name = fileName ?? basename(path);
    } else if (data !== undefined) {
      if (!fileName) throw new Error("fileName is required when sending base64 data");
      bytes = Buffer.from(data, "base64");
      name = fileName;
    } else {
      throw new Error("Provide either 'path' (local file) or 'data' (base64)");
    }
    if (bytes.length === 0) throw new Error("Refusing to send an empty file");
    return asText(await sendMedia(accountId, chatId, bytes, { fileName: name, mimeType, caption }));
  },
);

server.tool(
  "download_media",
  "Download a message's media (scope: messages:read). Returns a saved file path by default, or set output='base64' for the bytes inline (images come back as a viewable image).",
  {
    accountId,
    chatId,
    messageId: z.coerce.number().int().describe("Message id whose media to download"),
    output: binaryOutput,
  },
  async ({ accountId, chatId, messageId, output }) =>
    fetchBinary(
      `/accounts/${accountId}/chats/${chatId}/messages/${messageId}/media`,
      output,
      `media_${chatId}_${messageId}`,
    ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`vasya-mcp ready (api: ${BASE_URL})`);
