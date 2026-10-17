import { readPairing } from './docker-state.ts';

try {
  const {profiles}=readPairing();
  const demoMode=process.env.PALKA_DEMO_MODE==='true';
  const activeProfiles=demoMode ? profiles : profiles.slice(0,1);
  const market=await fetch('http://127.0.0.1:4100/health',{signal:AbortSignal.timeout(3000)});
  if (!market.ok || !(await market.json()).ok) throw new Error('Market not ready');
  await Promise.all(activeProfiles.map(async p=>{
    const headers={Authorization:`Bearer ${p.sessionToken}`,Origin:`http://127.0.0.1:${p.port}`};
    const page=await fetch(`http://127.0.0.1:${p.port}/`,{signal:AbortSignal.timeout(3000)});
    if (!page.ok || !(await page.text()).includes('<div id="root"></div>')) throw new Error('Local UI not ready');
    const healthResponse=await fetch(`http://127.0.0.1:${p.port}/api/health`,{headers,signal:AbortSignal.timeout(5000)});
    if (!healthResponse.ok) throw new Error('Local health unavailable');
    const health=await healthResponse.json();
    if (health.ownerId!==p.ownerId || health.mode!==(demoMode ? 'mock' : 'real')) throw new Error('Wrong profile mode');
    if (!health.wallet) {
      if (demoMode || !health.blockedReason) throw new Error('Wallet availability is unclear');
      return;
    }
    const response=await fetch(`http://127.0.0.1:${p.port}/api/state`,{headers,signal:AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error('Profile not ready');
    const state=await response.json();
    if (state.ownerId!==p.ownerId || state.mode!==(demoMode ? 'mock' : 'real')) throw new Error('Wrong profile');
    const snapshot=await fetch(`http://127.0.0.1:${p.port}/api/snapshot`,{headers,signal:AbortSignal.timeout(3000)});
    if (!snapshot.ok) throw new Error('Profile cannot reach market');
  }));
} catch {
  console.error('Market or local profiles are not ready.');
  process.exitCode=1;
}
