set -eu
python3 - <<'PY'
import json,pathlib,subprocess,hashlib,os
root=pathlib.Path('/data/autopod/rollout-134');journal=root/'network-probe.json';assert not journal.exists(),'single creation only'
p=subprocess.run(['journalctl','-u','autopod-daemon','--since','2026-09-10 09:05:15 UTC','--until','2026-09-10 09:05:21 UTC','-n','100','--no-pager','-o','json'],capture_output=True,timeout=10);matches=[]
for line in p.stdout.splitlines():
 try:j=json.loads(json.loads(line)['MESSAGE'])
 except Exception:continue
 if j.get('msg')=='Azure sandbox create accepted' and j.get('sandboxId')=='12b21a50-930d-4a0c-8e3a-d99f872e73b4':matches.append(j['diskImageId'])
assert len(matches)==1;disk=matches[0]
pid=int(subprocess.check_output(['systemctl','show','autopod-daemon','-p','MainPID','--value']));env=dict(x.split('=',1) for x in (pathlib.Path('/proc')/str(pid)/'environ').read_text().split('\0') if '=' in x);env['GOAL_PROBE_DISK_ID']=disk
js=r'''
import { DefaultAzureCredential } from '/opt/autopod/releases/089442b6/packages/daemon/node_modules/@azure/identity/dist/esm/index.js';
import fs from 'node:fs';
const journal='/data/autopod/rollout-134/network-probe.json', pod='goal-134-network-20260910';const disk=process.env.GOAL_PROBE_DISK_ID;if(!/^[a-f0-9-]{36}$/.test(disk))throw Error('disk identity');
const base=`https://management.northeurope.azuredevcompute.io/subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${process.env.AZURE_RESOURCE_GROUP}/sandboxGroups/autopod-spike-neu`;
const token=await new DefaultAzureCredential().getToken('https://dynamicsessions.io/.default');
const out={startedAt:new Date().toISOString(),sourceSandbox:'12b21a50-930d-4a0c-8e3a-d99f872e73b4',diskImageId:disk,pod,providerCalls:0,elapsedCapSeconds:240,estimatedSpend:'One existing disk-image sandbox, at most four minutes of 2 CPU / 4 GiB allocation; no model calls. Exact infrastructure billing unavailable.',checks:[]};
function save(){fs.writeFileSync(journal,JSON.stringify(out),{mode:0o600});}
async function req(method,path,body){const r=await fetch(base+path+'?api-version=2026-02-01-preview',{method,headers:{Authorization:`Bearer ${token.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000),redirect:'error'});const raw=await r.text();if(raw.length>262144)throw Error('response bound');return {status:r.status,body:raw?JSON.parse(raw):null};}
const d=await req('GET','/diskimages/'+disk);if(d.status!==200||d.body.id!==disk)throw Error('source disk unavailable');out.diskLabels=d.body.labels??d.body.properties?.labels;out.status='create_intent';save();let id;
try{
 const v=await req('PUT','/sandboxes',{sourcesRef:{diskImage:{id:disk}},resources:{cpu:'2000m',memory:'4096Mi',disk:'40Gi'},lifecycle:{autoSuspendPolicy:{enabled:true,interval:900,mode:'Memory'}},environment:{},egressPolicy:{defaultAction:'Deny',hostRules:[{action:'Allow',pattern:'autopod-daemon-ewi.swedencentral.cloudapp.azure.com'}]},labels:{purpose:'autopod-goal-probe',managedBy:'autopod',podId:pod}});
 out.createStatus=v.status;if(v.status!==200&&v.status!==201&&v.status!==202){out.createErrorCode=v.body?.error?.code??v.body?.code;throw Error('create rejected');}
 id=v.body.id;if(!/^[a-f0-9-]{36}$/.test(id))throw Error('created id');out.id=id;save();
 let observed;for(let i=0;i<30;i++){observed=await req('GET','/sandboxes/'+id);if(observed.status===200&&observed.body.state==='Running')break;await new Promise(r=>setTimeout(r,1000));}if(observed?.body?.state!=='Running'||observed.body.labels?.podId!==pod)throw Error('not owned running');out.observedEgress=observed.body.egressPolicy;save();
 const command="sh -c 'for mode in --http1.1 --http2; do for n in 1 2; do curl $mode --silent --show-error --max-time 8 --output /dev/null --write-out \"http=%{http_code} version=%{http_version}\\n\" https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com/health; done; done'";
 const e=await req('POST','/sandboxes/'+id+'/executeShellCommand',{command,user:'autopod'});out.checks.push({status:e.status,result:e.body});out.status='probe_executed';save();
}catch(e){out.status='probe_incomplete';out.error=e.message;save();}
finally{if(id){const owner=await req('GET','/sandboxes/'+id);if(owner.status===200&&owner.body.id===id&&owner.body.labels?.podId===pod&&owner.body.labels?.purpose==='autopod-goal-probe'){out.deleteStatus=(await req('DELETE','/sandboxes/'+id)).status;for(let i=0;i<10;i++){out.finalStatus=(await req('GET','/sandboxes/'+id)).status;if(out.finalStatus===404)break;await new Promise(r=>setTimeout(r,1000));}}else out.finalStatus=owner.status;}out.finishedAt=new Date().toISOString();save();}
console.log(JSON.stringify(out));
'''
f=root/'network-probe.mjs';f.write_text(js);os.chmod(f,0o600);subprocess.run(['chown','ewi:ewi',str(f)],check=True)
p=subprocess.run(['sudo','-u','ewi','--preserve-env','node',str(f)],env=env,capture_output=True,text=True,timeout=230)
assert len(p.stdout)<18000;print(p.stdout);print(json.dumps({'exitCode':p.returncode,'stderrPresent':bool(p.stderr)}))
PY
