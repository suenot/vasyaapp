import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';

export type StorageMode = 'local' | 'remote';

type StorageModePayload = {
  mode: 'Local';
} | {
  mode: 'Remote';
  url: string;
  api_key: string | null;
};

interface SettingsStore {
  apiId: string | null;
  apiHash: string | null;
  isConfigured: boolean;

  // Storage mode
  storageMode: StorageMode;
  backendUrl: string;
  // NOTE: API key is persisted to localStorage via zustand persist middleware.
  // This is acceptable for a desktop Tauri app (equivalent to storing in the app's data dir).
  backendApiKey: string;
  storageSwitching: boolean;
  storageError: string | null;
  folderLayout: 'horizontal' | 'vertical';
  chatDensity: 'normal' | 'compact' | 'very-compact';
  messageTextSize: 'small' | 'medium' | 'large';
  markdownMode: 'plain' | 'rendered';
  mergeMessages: boolean;
  interfaceScale: number;
  notificationsEnabled: boolean;
  notificationSound: boolean;
  messagePreview: boolean;
  // Calls are experimental: the VoIP transport has no real encryption yet,
  // so the whole feature is opt-in and hidden by default.
  experimentalCalls: boolean;

  setApiCredentials: (apiId: string, apiHash: string) => void;
  markConfigured: () => void;
  clearApiCredentials: () => void;

  setStorageMode: (mode: StorageMode, url?: string, apiKey?: string) => Promise<void>;
  setFolderLayout: (layout: 'horizontal' | 'vertical') => void;
  setChatDensity: (density: 'normal' | 'compact' | 'very-compact') => void;
  setMessageTextSize: (size: 'small' | 'medium' | 'large') => void;
  setMarkdownMode: (mode: 'plain' | 'rendered') => void;
  setMergeMessages: (merge: boolean) => void;
  setInterfaceScale: (scale: number) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setNotificationSound: (enabled: boolean) => void;
  setMessagePreview: (enabled: boolean) => void;
  setExperimentalCalls: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      apiId: null,
      apiHash: null,
      isConfigured: false,

      storageMode: 'local' as StorageMode,
      backendUrl: 'http://localhost:3000',
      backendApiKey: '',
      storageSwitching: false,
      storageError: null,
      folderLayout: 'horizontal',
      chatDensity: 'normal',
      messageTextSize: 'medium' as const,
      markdownMode: 'plain' as const,
      mergeMessages: true,
      interfaceScale: 100,
      notificationsEnabled: true,
      notificationSound: true,
      messagePreview: true,
      experimentalCalls: false,

      setApiCredentials: (apiId, apiHash) => set({
        apiId,
        apiHash,
        isConfigured: true,
      }),

      markConfigured: () => set({
        isConfigured: true,
      }),

      clearApiCredentials: () => set({
        apiId: null,
        apiHash: null,
        isConfigured: false,
      }),

      setStorageMode: async (mode, url, apiKey) => {
        set({ storageSwitching: true, storageError: null });
        try {
          const payload: StorageModePayload = mode === 'local'
            ? { mode: 'Local' }
            : { mode: 'Remote', url: url || get().backendUrl, api_key: apiKey || get().backendApiKey || null };

          await invoke('set_storage_mode', { mode: payload });

          set({
            storageMode: mode,
            backendUrl: url || get().backendUrl,
            backendApiKey: apiKey !== undefined ? apiKey : get().backendApiKey,
            storageSwitching: false,
          });
        } catch (err) {
          set({
            storageSwitching: false,
            storageError: String(err),
          });
          throw err;
        }
      },
      setFolderLayout: (layout) => set({ folderLayout: layout }),
      setChatDensity: (density) => set({ chatDensity: density }),
      setMessageTextSize: (size) => set({ messageTextSize: size }),
      setMarkdownMode: (mode) => set({ markdownMode: mode }),
      setMergeMessages: (merge) => set({ mergeMessages: merge }),
      setInterfaceScale: (scale) => set({ interfaceScale: scale }),
      setNotificationsEnabled: (enabled) => set({ notificationsEnabled: enabled }),
      setNotificationSound: (enabled) => set({ notificationSound: enabled }),
      setMessagePreview: (enabled) => set({ messagePreview: enabled }),
      setExperimentalCalls: (enabled) => set({ experimentalCalls: enabled }),
    }),
    {
      name: 'telegram-settings',
    }
  )
);
