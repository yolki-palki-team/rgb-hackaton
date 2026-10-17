import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const dockerStateDir=resolve('.state/docker');
const owners=['A','B','C'] as const;
const secret=z.string().regex(/^[a-f0-9]{64}$/);
const profileSchema=z.object({ownerId:z.enum(owners),port:z.number().int(),marketToken:secret,sessionToken:secret}).strict();
const pairingSchema=z.object({mode:z.literal('mock'),profiles:z.array(profileSchema).length(3)}).strict().superRefine(({profiles},ctx)=>{
  const tokens=profiles.flatMap(p=>[p.marketToken,p.sessionToken]);
  if (profiles.some((p,i)=>p.ownerId!==owners[i] || p.port!==4101+i) || new Set(tokens).size!==tokens.length) ctx.addIssue({code:'custom',message:'Invalid Docker demo profiles'});
});

export function readPairing(dir=dockerStateDir) {
  return pairingSchema.parse(JSON.parse(readFileSync(resolve(dir,'pairing.json'),'utf8')));
}

export function ensurePairing(dir=dockerStateDir) {
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path=resolve(dir,'pairing.json');
  if (!existsSync(path)) {
    const profiles=owners.map((ownerId,index)=>({ownerId,port:4101+index,marketToken:randomBytes(32).toString('hex'),sessionToken:randomBytes(32).toString('hex')}));
    writeFileSync(path,JSON.stringify({mode:'mock',profiles},null,2),{mode:0o600,flag:'wx'});
  }
  // Never rotate malformed credentials over existing state. Fail for repair.
  return readPairing(dir);
}
