import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getTransport, getTransportMode, getServerConfig } from '../transport';

export interface ChatTranslationPreferences { incomingEnabled: boolean; outgoingEnabled: boolean; incomingTarget: string; outgoingTarget: string }
export const DEFAULT_CHAT_TRANSLATION: ChatTranslationPreferences = { incomingEnabled: false, outgoingEnabled: false, incomingTarget: 'en', outgoingTarget: 'zh' };
export interface TranslationSettings { base_url: string; model: string; api_key_set: boolean }
export interface TranslationSettingsInput { base_url: string; model: string; api_key?: string }
export function translationBackendKey(): string {
  if (getTransportMode() === 'embedded') return 'embedded';
  const raw = getServerConfig()?.baseUrl ?? '';
  let url = raw.replace(/\/+$/, '');
  try { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; url = parsed.toString().replace(/\/+$/, ''); } catch { /* unconfigured server */ }
  return `remote:${url}`;
}
/** Session-only namespace; never persist tokens or use this fingerprint for authentication. */
export function translationSessionKey(): string {
  const token = getTransportMode() === 'remote' ? getServerConfig()?.token ?? '' : '';
  let a = 2166136261, b = 2246822519;
  for (let i = 0; i < token.length; i++) { a = Math.imul(a ^ token.charCodeAt(i), 16777619); b = Math.imul(b ^ token.charCodeAt(i), 3266489917); }
  return `${translationBackendKey()}:${token.length}:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
export function translationChatKey(accountId: string, chatId: number): string { return JSON.stringify([translationBackendKey(), accountId, chatId]); }
interface TranslationState {
  chats: Record<string, ChatTranslationPreferences>;
  settings: TranslationSettings | null;
  loading: boolean; error: string | null; generation: number;
  setChatPreferences: (accountId: string, chatId: number, patch: Partial<ChatTranslationPreferences>) => void;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: TranslationSettingsInput) => Promise<void>;
}
let settingsRequest = 0;
export const useTranslationStore = create<TranslationState>()(persist((set) => ({
  chats: {}, settings: null, loading: false, error: null, generation: 0,
  setChatPreferences: (accountId, chatId, patch) => {
    const key = translationChatKey(accountId, chatId);
    set(state => ({ chats: { ...state.chats, [key]: { ...DEFAULT_CHAT_TRANSLATION, ...state.chats[key], ...patch } } }));
  },
  loadSettings: async () => {
    const scope = translationSessionKey(); const request = ++settingsRequest; const transport = getTransport();
    set({ loading: true, error: null, settings: null });
    try { const settings = await transport.call<TranslationSettings>('get_translation_settings');
      if (scope === translationSessionKey() && request === settingsRequest) set({ settings, loading: false });
    } catch (error) { if (scope === translationSessionKey() && request === settingsRequest) set({ loading: false, error: error instanceof Error ? error.message : String(error) }); }
  },
  saveSettings: async (settings) => {
    const scope = translationSessionKey(); const request = ++settingsRequest; const transport = getTransport();
    set({ loading: true, error: null });
    try {
      await transport.call('set_translation_settings', { settings });
      if (scope === translationSessionKey()) set(state => ({ generation: state.generation + 1 }));
      if (scope !== translationSessionKey()) throw new Error('Connection changed while saving translation settings.');
      const saved = await transport.call<TranslationSettings>('get_translation_settings');
      if (request === settingsRequest && scope === translationSessionKey()) set({ settings: saved, loading: false });
    } catch (error) {
      if (scope === translationSessionKey() && request === settingsRequest) set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },
}), { name: 'vasya-chat-translation-v1', partialize: state => ({ chats: state.chats }) }));
