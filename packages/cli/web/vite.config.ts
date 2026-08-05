import react from "@vitejs/plugin-react"
import path from "path"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:4097'

  return {
    plugins: [react()],
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      modulePreload: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined

            if (id.includes('/react/') || id.includes('/react-dom/')) {
              return 'vendor-react'
            }

            if (id.includes('/@xterm/')) {
              return 'vendor-xterm'
            }

            if (id.includes('/@monaco-editor/') || id.includes('/monaco-editor/')) {
              return 'vendor-monaco'
            }

            if (
              id.includes('/react-markdown/') ||
              id.includes('/react-syntax-highlighter/') ||
              id.includes('/remark-') ||
              id.includes('/rehype-') ||
              id.includes('/micromark') ||
              id.includes('/unified/') ||
              id.includes('/prismjs/')
            ) {
              return 'vendor-markdown'
            }

            if (id.includes('/@radix-ui/')) {
              return 'vendor-radix'
            }

            if (id.includes('/lucide-react/')) {
              return 'vendor-icons'
            }

            return undefined
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@api": path.resolve(__dirname, "../src/api"),
      },
    },
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        '/health': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/sessions': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/events': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/tasks': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/configs': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/permissions': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/providers': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/models': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/global': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/suggestions': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/terminal/ws': {
          target: apiTarget.replace('http', 'ws'),
          ws: true,
        },
        '/terminal': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/mcp': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/skills': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
