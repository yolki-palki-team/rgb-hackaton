import { readPairing } from './docker-state.ts';

try {
  const {profiles}=readPairing();
  const market=await fetch('http://127.0.0.1:4100/health',{signal:AbortSignal.timeout(3000)});
  if (!market.ok || !(await market.json()).ok) throw new Error('Market not ready');
  await Promise.all(profiles.map(async p=>{
    const headers={Authorization:`Bearer ${p.sessionToken}`,Origin:'http://127.0.0.1:5173'};
    const response=await fetch(`http://127.0.0.1:${p.port}/api/state`,{headers,signal:AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error('Profile not ready');
    const state=await response.json();
    if (state.ownerId!==p.ownerId || state.mode!=='mock') throw new Error('Wrong profile');
    const snapshot=await fetch(`http://127.0.0.1:${p.port}/api/snapshot`,{headers,signal:AbortSignal.timeout(3000)});
    if (!snapshot.ok) throw new Error('Profile cannot reach market');
  }));
} catch {
  console.error('Market or local profiles are not ready.');
  process.exitCode=1;
}
