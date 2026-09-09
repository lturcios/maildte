import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthTokens, AuthUser } from '@/types/auth';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  /**
   * Solo credenciales: no vacía los stores de datos del tenant. Las vistas y el
   * cliente HTTP deben usar `endSession()` de src/stores/session.ts, que hace
   * las dos cosas. Llamarlo suelto deja el caché del tenant anterior en memoria.
   */
  logout: () => void;
  /**
   * Rota los tokens dentro de la MISMA sesión (refresh en 401). Para abrir una
   * sesión nueva se usa `startSession()` de src/stores/session.ts.
   */
  setTokens: (tokens: AuthTokens) => void;
  setUser: (user: AuthUser) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
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
