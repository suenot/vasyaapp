import { useCallback } from 'react';
import { invoke } from '../transport';

export function useTauriCommand<T, P = void>(command: string) {
  return useCallback(
    async (params?: P): Promise<T> => {
      console.log(`[Tauri] Calling command: ${command}`, params);
      try {
        const result = await invoke<T>(command, params as Record<string, unknown>);
        console.log(`[Tauri] Command ${command} success:`, result);
        return result;
      } catch (error) {
        console.error(`[Tauri] Command ${command} error:`, error);
        throw error;
      }
    },
    [command]
  );
}
