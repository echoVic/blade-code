import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/ping': 'http://localhost:8000',
            '/agents': 'http://localhost:8000',
            '/runs': 'http://localhost:8000',
            '/api': 'http://localhost:8000',
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
    },
});
