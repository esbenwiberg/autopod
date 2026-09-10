from pathlib import Path
import hashlib,base64
src=Path('/private/tmp/autopod-rollout-134');dst=Path('/private/tmp/autopod-rollout-136');old='089442b63e5827894da40c91c764b47ff4562073';new='425ff91cd5e6347b32d21b69804ea4c02008bc8e'
for name in ['dispatch.py','acceptance.py','backup.mjs','cutover-library.mjs','cutover.py','post-inspect.sh']:
 s=(src/name).read_text()
 if name=='cutover.py':s=s.replace('988d7c9d','OLD_PLACEHOLDER')
 s=s.replace('rollout-134','rollout-136').replace('goal-134','goal-136').replace(old,new).replace('089442b6','425ff91c').replace('OLD_PLACEHOLDER','089442b6')
 (dst/name).write_text(s)
semantic=r'''
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const root='/opt/autopod/releases/425ff91c',expected='425ff91cd5e6347b32d21b69804ea4c02008bc8e',dist=root+'/packages/daemon/dist';
const chunks=fs.readdirSync(dist).filter(n=>/^chunk-[A-Z0-9]+\.js$/.test(n));
const identities=[];for(const name of chunks.filter(n=>fs.readFileSync(path.join(dist,n),'utf8').includes('// <define:__AUTOPOD_RELEASE__>'))){const mod=await import(pathToFileURL(path.join(dist,name)).href);for(const v of Object.values(mod))if(v&&typeof v==='object'&&'commitSha'in v)identities.push({name,release:v});}
assert.equal(identities.length,1);assert.equal(identities[0].release.commitSha,expected);assert.equal(identities[0].release.dirty,false);assert.equal(identities[0].release.source,'build');
const status=execFileSync('git',['-C',root,'status','--porcelain','--','packages','package.json','pnpm-lock.yaml','turbo.json'],{encoding:'utf8'});assert.equal(status.trim(),'');assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),expected);
const shared=await import(pathToFileURL(root+'/packages/shared/dist/index.js').href);const request={profileName:'fixture',task:'fixture'};assert.equal(shared.createPodRequestSchema.parse({...request,tokenBudget:32000}).tokenBudget,32000);assert.equal(shared.createPodRequestSchema.parse({...request,tokenBudget:null}).tokenBudget,null);assert.equal(shared.createPodRequestSchema.parse(request).tokenBudget,undefined);assert.equal(shared.createPodRequestSchema.safeParse({...request,tokenBudget:0}).success,false);
const markers=chunks.filter(n=>fs.readFileSync(path.join(dist,n),'utf8').includes('async getImageDigest(sandboxId)'));assert.equal(markers.length,1);const mod=await import(pathToFileURL(path.join(dist,markers[0])).href);const digest='sha256:'+'a'.repeat(64);let pinned=true;const logger={child(){return this;},info(){},warn(){},debug(){},error(){}};
const client=new mod.AzureSandboxApiClient({subscriptionId:'fixture',resourceGroup:'fixture',location:'fixture',assumeGroupExists:true,credential:{async getToken(){return {token:'fixture'};}},retry:{maxAttempts:1},fetch:async(input,init)=>new Response(JSON.stringify(init?.method==='POST'?{exitCode:0,stdout:'{}',stderr:''}:new URL(input).pathname.includes('/diskimages/')?{id:'disk',status:{state:'Ready'},image:{base:pinned?'registry.test/image@'+digest:'registry.test/image:latest'},labels:{managedBy:'autopod',sourceDigest:digest}}:{id:'sandbox',state:'Running',resources:{cpu:'2000m',memory:'4096Mi'},sourcesRef:{diskImage:{id:'disk'}}}),{status:200})},logger);
const manager=new mod.SandboxContainerManager(client,logger);assert.equal((await manager.getExecutionMetadata('sandbox')).imageDigest,digest);pinned=false;assert.equal((await manager.getExecutionMetadata('sandbox')).imageDigest,null);
const receipt={status:'staged_semantics_verified',sha:expected,identities,checkoutClean:true,entryHash:createHash('sha256').update(fs.readFileSync(path.join(dist,'index.js'))).digest('hex'),sandboxModule:markers[0],sandboxModuleHash:createHash('sha256').update(fs.readFileSync(path.join(dist,markers[0]))).digest('hex'),schemaBudgetRetention:true,omittedAndNullPreserved:true,invalidBudgetRejected:true,providerLinkedPinnedDigestVerified:true,mutableImportDigestUnavailable:true,scope:'Actual staged modules with local fake provider; not live image or MCP acceptance'};fs.writeFileSync('/data/autopod/rollout-136/staged-receipt.json',JSON.stringify(receipt),{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));
'''
(dst/'semantic-gate.mjs').write_text(semantic)
ops='/data/autopod/rollout-136';lines=['set -eu','umask 077',f'[ ! -e {ops} ]',f'install -d -m 700 -o ewi -g ewi {ops}']
for name in ['cutover-library.mjs','backup.mjs','cutover.py','semantic-gate.mjs']:
 raw=(dst/name).read_bytes();target=ops+'/'+name;lines.extend([f"base64 -d > {target} <<'FILEDATA'",base64.b64encode(raw).decode(),'FILEDATA',f"echo '{hashlib.sha256(raw).hexdigest()}  {target}' | sha256sum -c -",f'chown ewi:ewi {target}'])
lines.extend([f'ln -s /opt/autopod/releases/425ff91c/packages/daemon/node_modules {ops}/node_modules',f'node --check {ops}/backup.mjs',f'sudo -u ewi node {ops}/semantic-gate.mjs','echo CUTOVER_HELPERS_PREPARED'])
(dst/'prepare.sh').write_text('\n'.join(lines)+'\n')
for name in ['dispatch.py','acceptance.py','cutover.py']:compile((dst/name).read_text(),name,'exec')
print('Prepared schema-183 forward cutover and staged-module semantic gate; not activated.')
