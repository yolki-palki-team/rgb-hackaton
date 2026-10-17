import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),
  resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}},
  plugins:[tailwindcss(),{
    name:'public-market-reads',
    configureServer(server) {
      server.middlewares.use('/market-api',async(request,response)=>{
        const path=new URL(request.url ?? '/','http://localhost').pathname;
        response.setHeader('Content-Type','application/json');
        response.setHeader('Cache-Control','no-store');
        if (!['/health','/orders'].includes(path)) {response.writeHead(404);response.end('{"error":"Not found"}');return;}
        if (request.method!=='GET') {response.writeHead(405,{Allow:'GET'});response.end('{"error":"Read-only market endpoint"}');return;}
        try {
          // Deliberately forward no browser cookies, credentials, query or body.
          const upstream=await fetch(new URL(path,process.env.MARKET_URL ?? 'http://127.0.0.1:4100'),{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});
          response.writeHead(upstream.status);response.end(await upstream.text());
        } catch {response.writeHead(502);response.end('{"error":"Market unavailable"}');}
      });
    },
  }],
  server:{host:'127.0.0.1',port:5173,strictPort:true},
});
