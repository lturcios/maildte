import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// `vitest/config` reexporta `defineConfig` de Vite agregando la clave `test`.
// Se configura acá, y no en un `vitest.config.ts` aparte, para que los tests
// corran con el mismo alias `@`, el mismo plugin de React y el mismo pipeline
// de Tailwind que el build: una segunda config sería una copia que se
// desincroniza en silencio.
import { defineConfig } from 'vitest/config';

const rootDir = import.meta.dirname;

// Se sirve por Nginx bajo /panel en producción (ver base más abajo).
// Backend NestJS corre en http://localhost:3000 con prefijo global /api/v1.
// En desarrollo, el dev server de Vite (puerto 5173 por defecto) proxea
// /api hacia el backend para evitar problemas de CORS y no depender de
// variables de entorno para la URL del backend en dev.
export default defineConfig({
  base: '/panel/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  // Dependencias nuevas de desarrollo (regla 3 de CLAUDE.md): `vitest` como
  // runner porque comparte esta misma config de Vite; `jsdom` como DOM para
  // los tests de componentes; `@testing-library/react` (v16, requerida por
  // React 19), `@testing-library/user-event` y `@testing-library/jest-dom`
  // para renderizar, simular la interacción real del usuario y afirmar sobre
  // el DOM. Ninguna llega al bundle de producción.
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}'],
  },
});
