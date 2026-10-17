import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const MIME:Record<string,string>={
  '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8',
  '.svg':'image/svg+xml',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.webp':'image/webp',
  '.ico':'image/x-icon',
  '.woff':'font/woff',
  '.woff2':'font/woff2',
};
function isWithin(parent:string,child:string):boolean {
  const path=relative(parent,child);
  return Boolean(path) && path!=='..' && !path.startsWith(`..${sep}`);
}

export async function serveLocalUi(response:ServerResponse, rawPath:string, directory:string):Promise<boolean> {
  const path=rawPath.split('?')[0];
  if (path!=='/' && path!=='/index.html' && !/^\/assets\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(path)) return false;
  const entry=path.startsWith('/assets/') ? path.slice(1) : 'index.html';
  const mime=entry==='index.html' ? 'text/html; charset=utf-8' : MIME[extname(entry).toLowerCase()];
  if (!mime) return false;
  try {
    if ((await lstat(directory)).isSymbolicLink()) return false;
    if ((await lstat(resolve(directory,entry))).isSymbolicLink()) return false;
    const root=await realpath(directory);
    const candidate=await realpath(resolve(directory,entry));
    if (!isWithin(root,candidate)) return false;
    if (entry!=='index.html') {
      if ((await lstat(resolve(directory,'assets'))).isSymbolicLink()) return false;
      const assets=await realpath(resolve(directory,'assets'));
      if (!isWithin(root,assets) || !isWithin(assets,candidate)) return false;
    }
    if (!(await stat(candidate)).isFile()) return false;
    const contents=await readFile(candidate);
    response.writeHead(200,{'Content-Type':mime,'Cache-Control':entry==='index.html' ? 'no-store' : 'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});
    response.end(contents);
    return true;
  } catch(error) {
    if (error instanceof Error && 'code' in error && error.code==='ENOENT' && entry==='index.html') {
      response.writeHead(503,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
      response.end('Local UI is not built. Run the local UI build command, then reload.');
      return true;
    }
    return false;
  }
}
