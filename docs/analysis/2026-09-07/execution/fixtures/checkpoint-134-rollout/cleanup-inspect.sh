set -eu
python3 - <<'PY'
import json,pathlib,subprocess,urllib.request,urllib.error,datetime
pid=int(subprocess.check_output(['systemctl','show','autopod-daemon','-p','MainPID','--value']))
env=dict(x.split('=',1) for x in (pathlib.Path('/proc')/str(pid)/'environ').read_text().split('\0') if '=' in x)
selected={k:v for k,v in env.items() if k in ['SANDBOX_LOCATION','SANDBOX_GROUP','AZURE_LOCATION','AZURE_RESOURCE_GROUP','AZURE_SUBSCRIPTION_ID','SANDBOX_RESOURCE_GROUP']}
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'settings':selected}
p=subprocess.run(['journalctl','-u','autopod-daemon','--since','2026-09-10 09:05:00 UTC','-n','250','--no-pager','-o','json'],capture_output=True,timeout=15);assert len(p.stdout)<1024**2
items=[]
for line in p.stdout.splitlines():
 try:j=json.loads(json.loads(line)['MESSAGE'])
 except Exception:continue
 if isinstance(j,dict) and (j.get('podId')=='middle-tahr' or j.get('sandboxId')=='12b21a50-930d-4a0c-8e3a-d99f872e73b4' or j.get('containerId')=='12b21a50-930d-4a0c-8e3a-d99f872e73b4'):
  items.append({k:j[k] for k in ['time','msg','podId','sandboxId','containerId','status','exitCode'] if k in j})
out['events']=items[-20:];print(json.dumps(out))
PY
