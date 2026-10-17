import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerStateDir, ensurePairing } from './docker-state.ts';

// One-machine demo only: independent local state; no real keys or settlement.
const {profiles}=ensurePairing();
const children:ChildProcess[]=[];
let stopping=false;

async function stop(code=0) {
  if (stopping) return;
  stopping=true;
  const exited=children.filter(c=>c.exitCode===null && c.signalCode===null).map(child=>new Promise<void>(done=>{
    child.once('exit',()=>done());
    child.kill('SIGTERM');
  }));
  const deadline=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(code || 1);},25_000);
  deadline.unref();
  await Promise.all(exited);
  clearTimeout(deadline);
  process.exit(code);
}

function run(script:string,env:NodeJS.ProcessEnv) {
  const child=spawn(process.execPath,['--import','tsx',script],{env:{...process.env,...env},stdio:'inherit'});
  children.push(child);
  child.once('error',()=>{console.error(`Could not start ${script}`);void stop(1);});
  child.once('exit',(code,signal)=>{
    if (!stopping) {console.error(`${script} stopped unexpectedly (${signal ?? code})`);void stop(code || 1);}
  });
}

process.once('SIGINT',()=>void stop());
process.once('SIGTERM',()=>void stop());

try {
  // QVAC download deduplication is per process. Populate the shared model
  // cache once before three clients can request it concurrently.
  await new Promise<void>((done,reject)=>{
    const child=spawn(process.execPath,['--import','tsx','apps/local-client/scripts/docker-model.ts'],{env:process.env,stdio:'inherit'});
    children.push(child);
    child.once('error',reject);
    child.once('exit',code=>code===0 ? done() : reject(new Error('QVAC preparation failed')));
  });
  if (stopping) process.exit(0);
  run('apps/market/src/main.ts',{
    MARKET_HOST:'127.0.0.1',MARKET_PORT:'4100',MARKET_DB_PATH:resolve(dockerStateDir,'market.sqlite'),
    MARKET_TOKENS_JSON:JSON.stringify(Object.fromEntries(profiles.map(p=>[p.marketToken,p.ownerId]))),
  });
  let ready=false;
  for(let attempt=0;attempt<100 && !stopping;attempt++) {
    ready=await fetch('http://127.0.0.1:4100/health',{signal:AbortSignal.timeout(500)}).then(r=>r.ok).catch(()=>false);
    if (ready) break;
    await delay(100);
  }
  if (!ready) throw new Error('Market did not start');
  if (!stopping) for(const p of profiles) run('apps/local-client/src/main.ts',{
    LOCAL_HOST:'0.0.0.0',LOCAL_PORT:String(p.port),LOCAL_OWNER_ID:p.ownerId,LOCAL_SESSION_TOKEN:p.sessionToken,
    LOCAL_STATE_DIR:resolve(dockerStateDir,p.ownerId),LOCAL_ALLOWED_ORIGINS:'http://127.0.0.1:5173,http://localhost:5173',
    MARKET_URL:'http://127.0.0.1:4100',MARKET_TOKEN:p.marketToken,WALLET_MODE:'mock',
  });
  console.log('MOCK wallets A/B/C; real local QVAC. UI: http://127.0.0.1:5173. Pair with the documented docker compose exec command.');
} catch {
  console.error('Docker demo failed to start; inspect the service logs.');
  await stop(1);
}
