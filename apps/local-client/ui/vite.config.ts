import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

// Built assets are served by the local wallet's own API server.
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, plugins: [tailwindcss()] });
