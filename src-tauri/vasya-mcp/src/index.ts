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

const BASE_URL = (process.env.VASYA_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const AGENT_KEY = process.env.VASYA_AGENT_KEY;
if (!AGENT_KEY) {
  console.error("VASYA_AGENT_KEY is required (create one via POST /api/v1/agent-keys)");
  process.exit(1);
}

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

const server = new McpServer({ name: "vasya-mcp", version: "0.1.0" });

const accountId = z.string().describe("Telegram account id (from list_accounts)");
const chatId = z.coerce.number().int().describe("Chat id (bot-api format, from list_chats)");

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`vasya-mcp ready (api: ${BASE_URL})`);
