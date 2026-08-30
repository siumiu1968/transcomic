import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/transcomic/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/transcomic/api': 'http://127.0.0.1:4178',
    },
  },
})
