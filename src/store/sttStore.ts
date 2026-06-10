import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type SttProvider = 'deepgram' | 'local_whisper';

export interface SttSettings {
  provider: SttProvider;
  deepgram_api_key: string | null;
  whisper_model: string;
  language: string;
}

export interface WhisperModelInfo {
  name: string;
  downloaded: boolean;
  size: number | null; // bytes
}

export type WhisperProgressStep =
  | 'loading_model'
  | 'model_loaded'
  | 'converting_audio'
  | 'ffmpeg_converting'
  | 'audio_ready'
  | 'transcribing'
  | 'extracting_text'
  | 'done';

export interface WhisperProgress {
  event: WhisperProgressStep;
  detail?: string;
}

interface SttState {
  settings: SttSettings;
  loading: boolean;
  whisperModels: WhisperModelInfo[];
  // Transcription cache (chat_msg → text)
  transcriptions: Record<string, string>;
  transcribing: Set<string>;
  errors: Record<string, string>;
  whisperProgress: WhisperProgress | null;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: Partial<SttSettings>) => Promise<void>;
  loadWhisperModels: () => Promise<void>;
  downloadModel: (modelName: string) => Promise<void>;
  transcribe: (chatId: number, messageId: number, filePath: string) => Promise<string | null>;
  clearError: (key: string) => void;
  setWhisperProgress: (progress: WhisperProgress | null) => void;
}

const TRANSCRIBING_SET = new Set<string>();

export const useSttStore = create<SttState>((set, get) => ({
  settings: {
    // Placeholder until loadSettings() fetches the persisted value from Rust;
    // mirrors the Rust default (local Whisper — privacy-first).
    provider: 'local_whisper',
    deepgram_api_key: null,
    whisper_model: 'small',
    language: 'ru',
  },
  loading: false,
  whisperModels: [],
  transcriptions: {},
  transcribing: TRANSCRIBING_SET,
  errors: {},
  whisperProgress: null,

  loadSettings: async () => {
    try {
      const settings = await invoke<SttSettings>('get_stt_settings');
      console.log('[STT] Settings loaded:', {
        provider: settings.provider,
        hasApiKey: !!settings.deepgram_api_key,
        language: settings.language,
      });
      set({ settings });
    } catch (err) {
      console.error('[STT] Failed to load settings:', err);
    }
  },

  saveSettings: async (partial) => {
    const current = get().settings;
    const updated = { ...current, ...partial };
    try {
      await invoke('set_stt_settings', { settings: updated });
      set({ settings: updated });
    } catch (err) {
      console.error('[STT] Failed to save settings:', err);
    }
  },

  loadWhisperModels: async () => {
    try {
      const models = await invoke<[string, boolean, number | null][]>('get_whisper_models_status');
      set({
        whisperModels: models.map(([name, downloaded, size]) => ({
          name,
          downloaded,
          size,
        })),
      });
    } catch (err) {
      console.error('[STT] Failed to load whisper models:', err);
    }
  },

  downloadModel: async (modelName) => {
    set({ loading: true });
    try {
      await invoke('download_whisper_model', { modelName });
      await get().loadWhisperModels();
    } catch (err) {
      console.error('[STT] Failed to download model:', err);
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  transcribe: async (chatId, messageId, filePath) => {
    const key = `${chatId}_${messageId}`;
    const existing = get().transcriptions[key];
    if (existing !== undefined) return existing;

    if (get().transcribing.has(key)) return null;

    TRANSCRIBING_SET.add(key);
    set({ transcribing: new Set(TRANSCRIBING_SET) });

    try {
      console.log('[STT] Calling transcribe_audio command...', { chatId, messageId, filePath });
      const result = await invoke<{ text: string; language: string | null; cached: boolean }>(
        'transcribe_audio',
        { chatId, messageId, filePath }
      );
      console.log('[STT] Transcription result:', {
        textLength: result.text.length,
        cached: result.cached,
        preview: result.text.substring(0, 100),
      });
      TRANSCRIBING_SET.delete(key);
      set((state) => ({
        transcriptions: { ...state.transcriptions, [key]: result.text },
        transcribing: new Set(TRANSCRIBING_SET),
      }));
      return result.text;
    } catch (err) {
      console.error('[STT] Transcription failed:', err);
      TRANSCRIBING_SET.delete(key);
      const errorMsg = typeof err === 'string' ? err : (err as Error)?.message || 'Unknown error';
      set((state) => ({
        transcribing: new Set(TRANSCRIBING_SET),
        errors: { ...state.errors, [key]: errorMsg },
      }));
      return null;
    }
  },

  clearError: (key) => {
    set((state) => {
      const { [key]: _, ...rest } = state.errors;
      return { errors: rest };
    });
  },

  setWhisperProgress: (progress) => {
    set({ whisperProgress: progress });
  },
}));
