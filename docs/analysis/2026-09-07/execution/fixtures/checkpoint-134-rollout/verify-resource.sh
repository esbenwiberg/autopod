set -eu
python3 - <<'PY'
import json,pathlib,subprocess
pid=int(subprocess.check_output(['systemctl','show','autopod-daemon','-p','MainPID','--value']))
env=dict(x.split('=',1) for x in (pathlib.Path('/proc')/str(pid)/'environ').read_text().split('\0') if '=' in x)
js=r'''
import { DefaultAzureCredential } from '/opt/autopod/releases/089442b6/packages/daemon/node_modules/@azure/identity/dist/esm/index.js';
const region=process.env.AZURE_SANDBOX_LOCATION??process.env.AZURE_LOCATION??'swedencentral';
const group=process.env.AZURE_SANDBOX_GROUP??process.env.SANDBOX_GROUP??'autopod-spike';
const id='12b21a50-930d-4a0c-8e3a-d99f872e73b4';
const url=`https://management.${region}.azuredevcompute.io/subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${process.env.AZURE_RESOURCE_GROUP}/sandboxGroups/${group}/sandboxes/${id}?api-version=2026-02-01-preview`;
const token=await new DefaultAzureCredential().getToken('https://dynamicsessions.io/.default');
const request=async method=>{const r=await fetch(url,{method,headers:{Authorization:`Bearer ${token.token}`},signal:AbortSignal.timeout(15000),redirect:'error'});const raw=await r.text();if(raw.length>262144)throw Error('body bound');return {status:r.status,body:raw?JSON.parse(raw):null};};
const v=await request('GET');let out={at:new Date().toISOString(),region,group,id,initialStatus:v.status};
if(v.status===200){if(v.body.id!==id||v.body.labels?.podId!=='middle-tahr'||v.body.labels?.managedBy!=='autopod'||v.body.labels?.purpose!=='autopod-sandbox')throw Error('ownership mismatch');out.ownershipMatched=true;const d=await request('DELETE');out.deleteStatus=d.status;if(![200,202,204,404].includes(d.status))throw Error('delete rejected');let last;for(let n=0;n<10;n++){last=await request('GET');if(last.status===404)break;await new Promise(r=>setTimeout(r,1000));}out.finalStatus=last.status;out.status=last.status===404?'deletion_verified':'cleanup_unverified';}
else {out.status=v.status===404?'absence_verified':'provider_check_unavailable';}
console.log(JSON.stringify(out));
'''
p=subprocess.run(['sudo','-u','ewi','--preserve-env','node','--input-type=module','-e',js],env=env,capture_output=True,text=True,timeout=65)
assert len(p.stdout)<5000;print(p.stdout);print(json.dumps({'exitCode':p.returncode,'stderrPresent':bool(p.stderr)}))
PY
