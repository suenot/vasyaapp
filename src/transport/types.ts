/**
 * Transport abstraction between the React UI and the Telegram engine.
 *
 * The UI never talks to a specific bridge directly: under Tauri the engine
 * is reached over IPC (TauriTransport); in a plain browser it will be
 * reached over HTTP/GraphQL + WS (HttpTransport, not implemented yet).
 * See .claude/plans/web-api-session-host-2026-06.md §9.
 */
export interface TelegramTransport {
  /** True when running inside the Tauri shell (native capabilities available). */
  readonly isNative: boolean;

  /** Invoke a backend command by name (the IPC commands / future REST ops). */
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;

  /**
   * Send media as a raw binary body plus ASCII metadata headers
   * (values percent-encoded by the caller). Maps to
   * `invoke('send_media', bytes, { headers })` under Tauri and to a
   * raw-body POST over HTTP.
   */
  sendMedia<T>(bytes: Uint8Array, headers: Record<string, string>): Promise<T>;

  /**
   * Subscribe to a realtime event (e.g. 'telegram:new-message'); the handler
   * receives the event payload. Resolves to an unsubscribe function.
   */
  subscribe(event: string, handler: (payload: any) => void): Promise<() => void>;

  /**
   * Turn an engine-side file reference (an absolute path on the device today)
   * into a URL the webview can display (asset: under Tauri, a media URL
   * over HTTP).
   */
  convertFileSrc(filePath: string): string;
}
