import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthTokens, AuthUser } from '@/types/auth';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  login: (tokens: AuthTokens, user: AuthUser) => void;
  logout: () => void;
  setTokens: (tokens: AuthTokens) => void;
  setUser: (user: AuthUser) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      login: (tokens, user) =>
        set({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user,
        }),
      logout: () => set({ accessToken: null, refreshToken: null, user: null }),
      setTokens: (tokens) =>
        set({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
      setUser: (user) => set({ user }),
    }),
    {
      name: 'maildte-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
      }),
    },
  ),
);
