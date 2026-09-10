set -eu
python3 - <<'PY'
import json,pathlib,subprocess
pid=int(subprocess.check_output(['systemctl','show','autopod-daemon','-p','MainPID','--value']))
env=dict(x.split('=',1) for x in (pathlib.Path('/proc')/str(pid)/'environ').read_text().split('\0') if '=' in x)
js=r'''
import { DefaultAzureCredential } from '/opt/autopod/releases/089442b6/packages/daemon/node_modules/@azure/identity/dist/esm/index.js';
const region=process.env.AZURE_SANDBOX_LOCATION??process.env.AZURE_LOCATION??'swedencentral';
const group=process.env.AZURE_SANDBOX_GROUP??process.env.SANDBOX_GROUP??'autopod-spike';
const id='c6919935-56af-404a-8a91-0aab9ea4fe10';
const url=`https://management.${region}.azuredevcompute.io/subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${process.env.AZURE_RESOURCE_GROUP}/sandboxGroups/${group}/diskimages/${id}?api-version=2026-02-01-preview`;
const token=await new DefaultAzureCredential().getToken('https://dynamicsessions.io/.default');
const request=async method=>{const r=await fetch(url,{method,headers:{Authorization:`Bearer ${token.token}`},signal:AbortSignal.timeout(15000),redirect:'error'});const raw=await r.text();if(raw.length>262144)throw Error('body bound');return {status:r.status,body:raw?JSON.parse(raw):null};};
const v=await request('GET');console.log(JSON.stringify({at:new Date().toISOString(),region,group,id,status:v.status,keys:Object.keys(v.body??{}),image:v.body?.image,sourcesRef:v.body?.sourcesRef,labels:v.body?.labels,state:v.body?.state,diskState:v.body?.status??v.body?.properties?.status}));
'''
p=subprocess.run(['sudo','-u','ewi','--preserve-env','node','--input-type=module','-e',js],env=env,capture_output=True,text=True,timeout=65)
assert len(p.stdout)<5000;print(p.stdout);print(json.dumps({'exitCode':p.returncode,'stderrPresent':bool(p.stderr)}))
PY
