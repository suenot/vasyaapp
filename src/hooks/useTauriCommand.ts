import { useCallback } from 'react';
import { invoke } from '../transport';

export function useTauriCommand<T, P = void>(command: string) {
  return useCallback(
    async (params?: P): Promise<T> => {
      try {
        const result = await invoke<T>(command, params as Record<string, unknown>);
        return result;
      } catch (error) {
        console.error(`[Tauri] Command ${command} error:`, error);
        throw error;
      }
    },
    [command]
  );
}
