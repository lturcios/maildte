import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
});
