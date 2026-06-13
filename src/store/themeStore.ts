import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeSetting = 'system' | 'light' | 'dark' | 'blue';
export type ThemeMode = 'light' | 'dark' | 'blue';

interface ThemeState {
  // Настройка темы (что выбрал пользователь)
  themeSetting: ThemeSetting;

  // Фактическая тема (с учетом system)
  effectiveTheme: ThemeMode;

  // Действия
  setThemeSetting: (setting: ThemeSetting) => void;
  setEffectiveTheme: (theme: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      // Default to the Telegram-style dark-blue theme (not the light/orange one).
      themeSetting: 'blue',
      effectiveTheme: 'blue',

      setThemeSetting: (setting) => set({ themeSetting: setting }),
      setEffectiveTheme: (theme) => set({ effectiveTheme: theme }),
    }),
    {
      name: 'telegram-theme-storage',
      // Сохраняем только настройку, эффективную тему вычисляем при загрузке
      partialize: (state) => ({ themeSetting: state.themeSetting }),
    }
  )
);
