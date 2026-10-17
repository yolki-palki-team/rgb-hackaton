import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Built assets are served by the local wallet's own API server.
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url))});
