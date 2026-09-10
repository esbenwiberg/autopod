set -eu
cd /opt/autopod/releases/622fcbb5/packages/daemon
sudo -u ewi node --input-type=module - <<'JS'
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const root='/opt/autopod/releases/622fcbb5';const dist=root+'/packages/daemon/dist';
const chunks=fs.readdirSync(dist).filter(n=>/^chunk-[A-Z0-9]+\.js$/.test(n));
const identityFiles=chunks.filter(n=>fs.readFileSync(path.join(dist,n),'utf8').includes('// <define:__AUTOPOD_RELEASE__>'));
const identities=[];for(const name of identityFiles){const mod=await import(pathToFileURL(path.join(dist,name)).href);for(const v of Object.values(mod))if(v&&typeof v==='object'&&'commitSha'in v)identities.push({name,release:v});}
const marker=chunks.filter(n=>fs.readFileSync(path.join(dist,n),'utf8').includes('async getResourceAllocation(sandboxId)'));
const status=execFileSync('git',['-C',root,'status','--porcelain','--','packages','package.json','pnpm-lock.yaml','turbo.json'],{encoding:'utf8'});
console.log(JSON.stringify({sha:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),identities,resourceMethodChunks:marker,checkoutClean:status.trim()==='',statusPaths:status.split('\n').filter(Boolean).map(x=>x.slice(3)),entryHash:createHash('sha256').update(fs.readFileSync(path.join(dist,'index.js'))).digest('hex')}));
JS
