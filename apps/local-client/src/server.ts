import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { LocalError, LocalService } from './service.ts';

type ServerOptions = {token:string;allowedOrigins:string[]};
const BODY_LIMIT = 128 * 1024;
async function body(request:IncomingMessage):Promise<unknown> {
  let length=0;
  const chunks:Buffer[]=[];
  for await (const chunk of request) {
    length+=chunk.length;
    if (length>BODY_LIMIT) throw new LocalError('Request body too large',413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LocalError('Invalid JSON',400); }
}
function json(response:ServerResponse,status:number,value:unknown) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  response.end(JSON.stringify(value));
}
export function createLocalServer(service:LocalService,options:ServerOptions) {
  if (options.token.length<32) throw new Error('Local pairing token must have at least 32 characters');
  const expected=Buffer.from(`Bearer ${options.token}`);
  return createServer(async(request,response)=>{
    try {
      const host=(request.headers.host ?? '').split(':')[0];
      if (!['127.0.0.1','localhost'].includes(host)) throw new LocalError('Invalid Host',403);
      const origin=request.headers.origin;
      if (!origin || !options.allowedOrigins.includes(origin)) throw new LocalError('Origin is not paired',403);
      response.setHeader('Access-Control-Allow-Origin',origin);
      response.setHeader('Vary','Origin');
      if (request.method==='OPTIONS') {
        response.writeHead(204,{'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Max-Age':'600'});
        response.end(); return;
      }
      const actual=Buffer.from(request.headers.authorization ?? '');
      if (actual.length!==expected.length || !timingSafeEqual(actual,expected)) throw new LocalError('Local pairing required',401);
      const path=new URL(request.url ?? '/','http://127.0.0.1').pathname;
      if (request.method==='GET') {
        if (path==='/api/health') return json(response,200,await service.health());
        if (path==='/api/state') return json(response,200,await service.state());
        if (path==='/api/policy') return json(response,200,await service.policy());
        if (path==='/api/snapshot') return json(response,200,await service.market.snapshot());
        const trade=/^\/api\/trades\/([a-zA-Z0-9:._-]+)$/.exec(path);
        if (trade) return json(response,200,await service.trade(trade[1]));
      }
      if (request.method==='POST') {
        const input=await body(request);
        const result=await service.exclusive(async()=>{
          if (path==='/api/interpret') return service.interpret(input);
          if (path==='/api/draft/validate') return service.validateDraft(input);
          if (path==='/api/orders') return service.publish(input);
          const cancel=/^\/api\/orders\/([a-zA-Z0-9:._-]+)\/cancel$/.exec(path);
          if (cancel) {
            const payload=z.object({revision:z.number().int().nonnegative()}).strict().parse(input);
            return service.market.request(`/orders/${cancel[1]}/cancel`,'POST',payload);
          }
          const trade=/^\/api\/trades\/([a-zA-Z0-9:._-]+)\/(prepare|preview|approve|sync|reject)$/.exec(path);
          if (trade) {
            const [,id,action]=trade;
            if (action==='prepare') return service.prepare(id);
            if (action==='preview') return service.preview(id);
            if (action==='approve') return service.approve(id,input);
            if (action==='sync') return service.sync(id);
            if (action==='reject') return service.reject(id,z.object({reason:z.string().trim().min(1).max(500)}).strict().parse(input).reason);
          }
          throw new LocalError('Not found',404);
        });
        return json(response,200,result);
      }
      throw new LocalError('Not found',404);
    } catch(error) {
      if (error instanceof z.ZodError) return json(response,400,{error:'Некорректные данные: проверьте суммы, активы и обязательные поля',code:'INVALID_INPUT'});
      if (error instanceof LocalError) return json(response,error.status,{error:error.message,code:error.code});
      // No prompt, balances, model output or credentials in error logs.
      return json(response,400,{error:error instanceof Error ? error.message : 'Local operation failed',code:'LOCAL_ERROR'});
    }
  });
}
