import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';

interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

function applyThemeClass(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      theme: 'dark',
      setTheme: (theme) => {
        applyThemeClass(theme);
        set({ theme });
      },
      toggleTheme: () => {
        const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
        applyThemeClass(next);
        set({ theme: next });
      },
    }),
    {
      name: 'maildte-ui',
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyThemeClass(state.theme);
        }
      },
    },
  ),
);
