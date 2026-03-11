import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: './frontend',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
  },
})
