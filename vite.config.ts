import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: { port: 5173 },
  // The OAuth consent page is its own entry so it shares the app's env and
  // supabase-js build, and still ships as a real /oauth-consent.html.
  build: {
    rolldownOptions: {
      input: {
        main: path.resolve(import.meta.dirname, 'index.html'),
        consent: path.resolve(import.meta.dirname, 'oauth-consent.html'),
      },
    },
  },
})
