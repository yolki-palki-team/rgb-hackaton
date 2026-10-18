import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import tailwindcss from '@tailwindcss/vite';
import { PRESENTATION_URL } from './src/links';

const presentationFile = new URL('../../presentation/palka-presentation.html', import.meta.url);

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    tailwindcss(),
    {
      name: 'standalone-presentation',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (new URL(request.url ?? '/', 'http://localhost').pathname !== PRESENTATION_URL) {
            next();
            return;
          }
          try {
            const html = await readFile(presentationFile);
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
      async generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: PRESENTATION_URL.slice(1),
          source: await readFile(presentationFile),
        });
      },
    },
    {
      name: 'public-market-reads',
      configureServer(server) {
        server.middlewares.use('/market-api', async (request, response) => {
          const url = new URL(request.url ?? '/', 'http://localhost');
          const path = url.pathname;
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          if (!['/health', '/orders', '/activity', '/history'].includes(path)) {
            response.writeHead(404);
            response.end('{"error":"Not found"}');
            return;
          }
          if (request.method !== 'GET') {
            response.writeHead(405, { Allow: 'GET' });
            response.end('{"error":"Read-only market endpoint"}');
            return;
          }
          try {
            const upstreamUrl = new URL(path, process.env.MARKET_URL ?? 'http://127.0.0.1:4100');
            if (path === '/history' && url.searchParams.has('cursor')) {
              const cursor = url.searchParams.get('cursor') ?? '';
              if (!/^[a-zA-Z0-9_-]{1,300}$/.test(cursor)) {
                response.writeHead(400);
                response.end('{"error":"INVALID_HISTORY_CURSOR"}');
                return;
              }
              upstreamUrl.searchParams.set('cursor', cursor);
            }
            // Only the validated history cursor can cross this public proxy.
            const upstream = await fetch(upstreamUrl, {
              headers: { Accept: 'application/json' },
              redirect: 'error',
              signal: AbortSignal.timeout(5000),
            });
            response.writeHead(upstream.status);
            response.end(await upstream.text());
          } catch {
            response.writeHead(502);
            response.end('{"error":"Market unavailable"}');
          }
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
