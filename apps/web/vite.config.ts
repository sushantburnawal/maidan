import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env;

export default defineConfig({
  cacheDir: env?.VITE_CACHE_DIR ?? 'node_modules/.vite',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173
  }
});
