import react from "@vitejs/plugin-react"
import path from "path"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.VITE_API_TARGET || 'http://localhost:4097'
  const rootNodeModules = path.resolve(__dirname, '../../../node_modules')

  return {
    plugins: [react()],
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined

            if (
              /\/node_modules\/react\//.test(id) ||
              /\/node_modules\/react-dom\//.test(id)
            ) {
              return 'vendor-react'
            }

            if (id.includes('/@xterm/')) {
              return 'vendor-xterm'
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
      dedupe: ['react', 'react-dom', 'zustand'],
      alias: [
        {
          find: /^react$/,
          replacement: path.join(rootNodeModules, 'react/index.js'),
        },
        {
          find: /^react\/jsx-runtime$/,
          replacement: path.join(rootNodeModules, 'react/jsx-runtime.js'),
        },
        {
          find: /^react\/jsx-dev-runtime$/,
          replacement: path.join(rootNodeModules, 'react/jsx-dev-runtime.js'),
        },
        {
          find: /^react-dom$/,
          replacement: path.join(rootNodeModules, 'react-dom/index.js'),
        },
        {
          find: /^react-dom\/client$/,
          replacement: path.join(rootNodeModules, 'react-dom/client.js'),
        },
        {
          find: /^react-dom\/test-utils$/,
          replacement: path.join(rootNodeModules, 'react-dom/test-utils.js'),
        },
        { find: '@api', replacement: path.resolve(__dirname, '../src/api') },
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
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
        '/projects': {
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
        '/plugins': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/schedules': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/hooks': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
