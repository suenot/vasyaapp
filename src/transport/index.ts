import { HttpTransport } from './http';
import { TauriTransport } from './tauri';
import type { TelegramTransport } from './types';

export type { TelegramTransport } from './types';
export {
  getServerConfig,
  setServerConfig,
  clearServerConfig,
  isServerConfigured,
  type ServerConfig,
} from './http';

/**
 * 'embedded' — the engine runs in-process (Tauri shell, today's default).
 * 'remote' — the engine lives on a server, reached over HTTP/GraphQL + WS.
 */
export type TransportMode = 'embedded' | 'remote';

let mode: TransportMode = 'embedded';
let transport: TelegramTransport | null = null;

/**
 * Switch the connection mode (the future Embedded/Remote-server setting calls
 * this — a setter rather than a settingsStore read because the stores
 * themselves talk through the transport, which would be a circular import).
 * Resets the cached transport; event subscriptions made on the old transport
 * must be re-established by the caller.
 */
export function setTransportMode(next: TransportMode): void {
  if (next === mode) return;
  mode = next;
  transport = null;
}

export function getTransportMode(): TransportMode {
  return mode;
}

/** Resolve the transport for the current mode and environment. */
export function getTransport(): TelegramTransport {
  if (!transport) {
    const hasTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (mode === 'embedded' && hasTauri) {
      transport = new TauriTransport();
    } else if (mode === 'embedded') {
      // A plain browser has no embedded engine; only remote mode can work there.
      throw new Error('Embedded engine is only available inside Tauri — switch to remote mode');
    } else {
      // Remote mode works even before the server connection is configured:
      // calls fail soft and subscribe is a no-op until ServerConnect saves
      // a config (the app mounts listeners at boot, before the gate).
      transport = new HttpTransport();
    }
  }
  return transport;
}

// Thin facades so call sites keep their familiar shape; only the import
// changes when a file migrates off the Tauri APIs.

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return getTransport().call<T>(command, args);
}

export function sendMedia<T>(bytes: Uint8Array, headers: Record<string, string>): Promise<T> {
  return getTransport().sendMedia<T>(bytes, headers);
}

export function subscribe<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void> {
  return getTransport().subscribe(event, handler);
}

export function convertFileSrc(filePath: string): string {
  return getTransport().convertFileSrc(filePath);
}
