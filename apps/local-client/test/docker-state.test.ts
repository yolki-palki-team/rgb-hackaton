import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ensurePairing, readPairing } from '../scripts/docker-state.ts';

test('Docker restart preserves distinct pairing and market credentials',()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'rgb-docker-state-'));
  try {
    const first=ensurePairing(dir);
    assert.deepEqual(ensurePairing(dir),first);
    assert.deepEqual(readPairing(dir),first);
    assert.equal(new Set(first.profiles.flatMap(p=>[p.sessionToken,p.marketToken])).size,6);
    assert.equal(statSync(resolve(dir,'pairing.json')).mode & 0o777,0o600);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('Malformed stored credentials fail without replacing credentials or database',()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'rgb-docker-invalid-'));
  try {
    ensurePairing(dir);
    const path=resolve(dir,'pairing.json');
    writeFileSync(path,'{"mode":"real"}');
    writeFileSync(resolve(dir,'market.sqlite'),'existing-state');
    assert.throws(()=>ensurePairing(dir));
    assert.equal(readFileSync(path,'utf8'),'{"mode":"real"}');
    assert.equal(readFileSync(resolve(dir,'market.sqlite'),'utf8'),'existing-state');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
