import react from "@vitejs/plugin-react"
import path from "path"
import { defineConfig } from "vite"

const API_TARGET = 'http://localhost:4097'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/health': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/event': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/sessions': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/configs': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/permissions': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/providers': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/models': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/global': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/suggestions': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/terminal/ws': {
        target: API_TARGET.replace('http', 'ws'),
        ws: true,
      },
      '/terminal': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
