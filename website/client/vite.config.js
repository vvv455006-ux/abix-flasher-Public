import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react()
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        // Keep the browser's Host header: the API rejects a request whose
        // Origin and Host disagree, and the page is served from 127.0.0.1.
        changeOrigin: false
      }
    }
  }
});
