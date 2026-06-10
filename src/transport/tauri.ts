import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TelegramTransport } from './types';

/** Desktop/mobile transport: talks to the Rust engine over the Tauri bridge. */
export class TauriTransport implements TelegramTransport {
  readonly isNative = true;

  call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(command, args);
  }

  sendMedia<T>(bytes: Uint8Array, headers: Record<string, string>): Promise<T> {
    return invoke<T>('send_media', bytes, { headers });
  }

  subscribe(event: string, handler: (payload: any) => void): Promise<() => void> {
    return listen(event, (e) => handler(e.payload));
  }

  convertFileSrc(filePath: string): string {
    return convertFileSrc(filePath);
  }
}
