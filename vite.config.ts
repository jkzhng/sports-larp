import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run api` serves the list API on 8787.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
})
