import type { TelegramTransport } from './types';

/**
 * HTTP transport: talks to a vasya-server instance (REST under /api/v1,
 * realtime over the SSE /events stream — same bus as the GraphQL
 * subscriptions, but matching this interface's account-agnostic
 * subscribe(event) semantics exactly).
 *
 * Command names and arg shapes are the Tauri IPC ones; this class maps them
 * onto the REST routes (vasya-server keeps DTOs byte-identical to the
 * desktop command results, so no response reshaping beyond the documented
 * exceptions: login flow, avatars/media, folders aggregation).
 */

export interface ServerConfig {
  /** e.g. http://127.0.0.1:8787 — no trailing slash. */
  baseUrl: string;
  /** Backend JWT (POST /api/auth/login) or embedded-mode VASYA_LOCAL_TOKEN. */
  token: string;
}

const CONFIG_KEY = 'vasya-server-config';

export function getServerConfig(): ServerConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    if (typeof parsed.baseUrl === 'string' && typeof parsed.token === 'string') {
      return { baseUrl: parsed.baseUrl.replace(/\/+$/, ''), token: parsed.token };
    }
  } catch {
    // corrupt config — treat as unconfigured
  }
  return null;
}

export function setServerConfig(config: ServerConfig): void {
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({ baseUrl: config.baseUrl.replace(/\/+$/, ''), token: config.token }),
  );
}

export function clearServerConfig(): void {
  localStorage.removeItem(CONFIG_KEY);
}

export function isServerConfigured(): boolean {
  return getServerConfig() !== null;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Commands whose features are 501-stubbed server-side or desktop-only. */
const UNSUPPORTED = new Set([
  'request_call', 'accept_call', 'confirm_call', 'discard_call',
  'set_call_volume', 'toggle_call_mute',
  'create_group_call', 'join_group_call', 'leave_group_call',
  'get_group_call_participants', 'toggle_group_call_mute',
  'get_stt_settings', 'set_stt_settings', 'transcribe_audio',
  'download_whisper_model', 'get_whisper_models_status',
  'get_storage_mode', 'set_storage_mode',
]);

/**
 * One shared SSE connection over fetch (EventSource cannot send the
 * Authorization header). Dispatches by SSE event name — the server uses the
 * original Tauri event names ('telegram:new-message', 'chat-loaded', …).
 */
class SseBus {
  private handlers = new Map<string, Set<(payload: any) => void>>();
  private abort: AbortController | null = null;
  private backoffMs = 2000;

  on(event: string, handler: (payload: any) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    this.connect();
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(event);
      if (this.handlers.size === 0) this.disconnect();
    };
  }

  private connect(): void {
    if (this.abort || !getServerConfig()) return;
    this.abort = new AbortController();
    void this.loop(this.abort);
  }

  private disconnect(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private async loop(ctl: AbortController): Promise<void> {
    while (!ctl.signal.aborted) {
      const cfg = getServerConfig();
      if (!cfg) return;
      try {
        const resp = await fetch(`${cfg.baseUrl}/api/v1/events`, {
          headers: { Authorization: `Bearer ${cfg.token}` },
          signal: ctl.signal,
        });
        if (!resp.ok || !resp.body) throw new HttpError(resp.status, `events stream HTTP ${resp.status}`);
        this.backoffMs = 2000;
        await this.read(resp.body, ctl);
      } catch (err) {
        if (ctl.signal.aborted) return;
        console.warn('[HttpTransport] events stream dropped, reconnecting:', err);
      }
      await new Promise((r) => setTimeout(r, this.backoffMs));
      this.backoffMs = Math.min(this.backoffMs * 2, 15000);
    }
  }

  private async read(body: ReadableStream<Uint8Array>, ctl: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (!ctl.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line.
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        this.dispatch(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    }
  }

  private dispatch(frame: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      // ':' keep-alive comments and 'id:' lines are ignored
    }
    if (data.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    this.handlers.get(event)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[HttpTransport] event handler for '${event}' threw:`, err);
      }
    });
  }
}

export class HttpTransport implements TelegramTransport {
  readonly isNative = false;

  private bus = new SseBus();

  async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (UNSUPPORTED.has(command)) {
      throw new Error(`'${command}' is not available in the web version`);
    }
    const a = (args ?? {}) as Record<string, any>;

    switch (command) {
      // --- credentials + Telegram login -------------------------------------
      case 'has_api_credentials': {
        const r = await this.json<{ configured: boolean }>('GET', '/telegram/credentials');
        return r.configured as T;
      }
      case 'update_api_credentials':
        // This route's body is snake_case (no camelCase rename server-side).
        return this.json<T>('PUT', '/telegram/credentials', {
          body: { api_id: a.apiId, api_hash: a.apiHash },
        });
      case 'request_login_code': {
        const r = await this.json<{ accountId: string; phone: string }>(
          'POST', '/telegram/login/code', { body: { phone: a.phone } },
        );
        // The UI treats token_data as an opaque account handle; over HTTP
        // that handle is the server-issued accountId.
        return { token_data: r.accountId, phone: r.phone } as T;
      }
      case 'verify_code': {
        const r = await this.json<{ status: string; user?: unknown }>(
          'POST', '/telegram/login/verify', { body: { accountId: a.token, code: a.code } },
        );
        // LoginForm switches to the 2FA step on a 'password required' error.
        if (r.status === 'password_required') throw new Error('password required');
        return r.user as T;
      }
      case 'check_password': {
        const r = await this.json<{ status: string; user?: unknown }>(
          'POST', '/telegram/login/password',
          { body: { accountId: a.accountId, password: a.password } },
        );
        return r.user as T;
      }
      case 'logout':
        return this.json<T>('DELETE', `/accounts/${a.accountId}`);

      // --- chats -------------------------------------------------------------
      case 'get_cached_chats':
        return this.json<T>('GET', `/accounts/${a.accountId}/chats`);
      case 'get_chats':
        return this.json<T>('GET', `/accounts/${a.accountId}/chats`, { query: { source: 'live' } });
      case 'start_loading_chats':
        return this.json<T>('POST', `/accounts/${a.accountId}/chats/load`);
      case 'delete_and_leave_chat':
        return this.json<T>('DELETE', `/accounts/${a.accountId}/chats/${a.chatId}`);
      case 'get_contacts':
        return this.json<T>('GET', `/accounts/${a.accountId}/contacts`);
      case 'create_group': {
        const r = await this.json<{ chatId: number }>(
          'POST', `/accounts/${a.accountId}/groups`,
          { body: { title: a.title, userIds: a.userIds } },
        );
        return r.chatId as T;
      }
      case 'create_channel': {
        const r = await this.json<{ chatId: number }>(
          'POST', `/accounts/${a.accountId}/channels`,
          { body: { title: a.title, about: a.about, isMegagroup: a.isMegagroup } },
        );
        return r.chatId as T;
      }

      // --- messages ----------------------------------------------------------
      case 'get_messages':
        return this.json<T>('GET', `/accounts/${a.accountId}/chats/${a.chatId}/messages`, {
          query: { offset_id: a.offsetId, limit: a.limit, topic_id: a.topicId },
        });
      case 'send_message':
        return this.json<T>('POST', `/accounts/${a.accountId}/chats/${a.chatId}/messages`, {
          body: { text: a.text, topicId: a.topicId },
        });
      case 'forward_messages':
        return this.json<T>('POST', `/accounts/${a.accountId}/messages/forward`, {
          body: { fromChatId: a.fromChatId, toChatId: a.toChatId, messageIds: a.messageIds },
        });
      case 'mark_messages_read':
        return this.json<T>('POST', `/accounts/${a.accountId}/chats/${a.chatId}/read`, {
          body: { maxId: a.maxId },
        });
      case 'download_media': {
        // Desktop returns MediaInfo[] with a local file path; over HTTP we
        // stream the bytes and hand back a blob: URL in the same shape —
        // convertFileSrc passes blob: URLs through untouched.
        const blob = await this.blob(
          `/accounts/${a.accountId}/chats/${a.chatId}/messages/${a.messageId}/media`,
        );
        const mime = blob.type || 'application/octet-stream';
        const mediaType = mime.startsWith('image/') ? 'photo'
          : mime.startsWith('video/') ? 'video'
          : mime.startsWith('audio/') ? 'audio'
          : 'document';
        return [{
          media_type: mediaType,
          file_path: URL.createObjectURL(blob),
          file_name: null,
          file_size: blob.size,
          mime_type: mime,
        }] as T;
      }

      // --- search + topics ---------------------------------------------------
      case 'search_messages':
        return this.json<T>('GET', `/accounts/${a.accountId}/chats/${a.chatId}/messages/search`, {
          query: { q: a.query, limit: a.limit },
        });
      case 'global_search':
        return this.json<T>('GET', `/accounts/${a.accountId}/search`, {
          query: { q: a.query, limit: a.limit },
        });
      case 'search_all_messages':
        return this.json<T>('GET', `/accounts/${a.accountId}/messages/search`, {
          query: { q: a.query, limit: a.limit },
        });
      case 'get_forum_topics':
        return this.json<T>('GET', `/accounts/${a.accountId}/chats/${a.chatId}/topics`);

      // --- avatars -----------------------------------------------------------
      case 'get_my_avatar':
        try {
          const blob = await this.blob(`/accounts/${a.accountId}/avatar`);
          return URL.createObjectURL(blob) as T;
        } catch (err) {
          if (err instanceof HttpError && err.status === 404) return null as T;
          throw err;
        }
      case 'get_user_photos': {
        const r = await this.json<{ count: number; urls: string[] }>(
          'GET', `/accounts/${a.accountId}/chats/${a.chatId}/photos`,
        );
        const out: string[] = [];
        for (const u of r.urls) {
          out.push(URL.createObjectURL(await this.blob(u)));
        }
        return out as T;
      }

      // --- folders / tabs ----------------------------------------------------
      // The desktop commands are account-implicit (records carry account_id);
      // the REST routes are account-scoped, so reads aggregate across the
      // caller's accounts and writes route by the record's account_id.
      case 'get_folders': {
        const lists = await Promise.all(
          (await this.accountIds()).map((id) => this.json<unknown[]>('GET', `/accounts/${id}/folders`)),
        );
        return lists.flat() as T;
      }
      case 'save_folder':
        return this.json<T>('POST', `/accounts/${a.folder.account_id}/folders`, { body: a.folder });
      case 'delete_folder': {
        await Promise.all(
          (await this.accountIds()).map((id) =>
            this.json<void>('DELETE', `/accounts/${id}/folders/${a.id}`)),
        );
        return undefined as T;
      }
      case 'get_tabs': {
        const lists = await Promise.all(
          (await this.accountIds()).map((id) => this.json<unknown[]>('GET', `/accounts/${id}/tabs`)),
        );
        return lists.flat() as T;
      }
      case 'save_tabs': {
        const tabs = a.tabs as Array<{ account_id: string }>;
        const accountId = tabs[0]?.account_id ?? (await this.accountIds())[0];
        if (!accountId) return undefined as T;
        return this.json<T>('PUT', `/accounts/${accountId}/tabs`, { body: tabs });
      }

      default:
        throw new Error(`'${command}' has no HTTP mapping yet`);
    }
  }

  async sendMedia<T>(bytes: Uint8Array, headers: Record<string, string>): Promise<T> {
    const cfg = this.config();
    const accountId = headers['x-account-id'];
    const chatId = headers['x-chat-id'];
    if (!accountId || !chatId) {
      throw new Error('sendMedia requires x-account-id and x-chat-id headers');
    }
    const h: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
    for (const name of ['x-file-name', 'x-mime-type', 'x-caption']) {
      if (headers[name] !== undefined) h[name] = headers[name];
    }
    const resp = await fetch(
      `${cfg.baseUrl}/api/v1/accounts/${accountId}/chats/${chatId}/media`,
      { method: 'POST', headers: h, body: bytes as unknown as BodyInit },
    );
    if (!resp.ok) throw await this.toError(resp);
    return resp.json() as Promise<T>;
  }

  subscribe(event: string, handler: (payload: any) => void): Promise<() => void> {
    // Before the server connection is configured the app still mounts its
    // listeners; resolve to a no-op so nothing crashes at boot.
    if (!isServerConfigured()) return Promise.resolve(() => {});
    return Promise.resolve(this.bus.on(event, handler));
  }

  convertFileSrc(filePath: string): string {
    if (/^(blob:|data:|https?:)/.test(filePath)) return filePath;
    if (filePath.startsWith('/api/')) {
      const cfg = getServerConfig();
      return cfg ? `${cfg.baseUrl}${filePath}` : filePath;
    }
    return filePath;
  }

  // --- HTTP plumbing ---------------------------------------------------------

  private config(): ServerConfig {
    const cfg = getServerConfig();
    if (!cfg) throw new Error('Server connection not configured');
    return cfg;
  }

  /** Resolve an /api/v1-relative path (absolute /api/ paths pass through). */
  private url(path: string, cfg: ServerConfig): string {
    return path.startsWith('/api/') ? `${cfg.baseUrl}${path}` : `${cfg.baseUrl}/api/v1${path}`;
  }

  private async json<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const cfg = this.config();
    const u = new URL(this.url(path, cfg));
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const resp = await fetch(u, { method, headers, body });
    if (!resp.ok) throw await this.toError(resp);
    if (resp.status === 204 || resp.status === 202) return undefined as T;
    if (!(resp.headers.get('content-type') ?? '').includes('json')) return undefined as T;
    return resp.json() as Promise<T>;
  }

  private async blob(path: string): Promise<Blob> {
    const cfg = this.config();
    const resp = await fetch(this.url(path, cfg), {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!resp.ok) throw await this.toError(resp);
    return resp.blob();
  }

  private async toError(resp: Response): Promise<Error> {
    let message = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      if (typeof data?.error === 'string') message = data.error;
    } catch {
      // non-JSON error body — keep the status message
    }
    return new HttpError(resp.status, message);
  }

  private async accountIds(): Promise<string[]> {
    const accounts = await this.json<Array<{ accountId: string }>>('GET', '/accounts');
    return accounts.map((acc) => acc.accountId);
  }
}
