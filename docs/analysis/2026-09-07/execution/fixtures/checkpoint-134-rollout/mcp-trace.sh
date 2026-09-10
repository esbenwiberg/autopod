set -eu
python3 - <<'PY'
import json,subprocess,pathlib
out={}
for unit in ['autopod-daemon','caddy']:
 p=subprocess.run(['journalctl','-u',unit,'--since','2026-09-10 09:05:20 UTC','--until','2026-09-10 09:05:44 UTC','-n','400','--no-pager','-o','json'],capture_output=True,timeout=15);assert len(p.stdout)<2*1024**2;items=[]
 for line in p.stdout.splitlines():
  try:j=json.loads(json.loads(line)['MESSAGE'])
  except Exception:continue
  if not isinstance(j,dict):continue
  req=j.get('req') or j.get('request') or {};uri=req.get('url') or req.get('uri') or j.get('url') or ''
  if '/mcp/middle-tahr' in str(uri) or 'mcp' in str(j.get('msg','')).lower():
   e=j.get('err') or {};items.append({'time':j.get('time',j.get('ts')),'msg':j.get('msg'),'method':req.get('method'),'uri':uri,'status':j.get('status',(j.get('res') or {}).get('statusCode')),'code':e.get('code'),'error':e.get('message')})
 out[unit]=items
out['caddyLogCandidates']=[str(x) for x in pathlib.Path('/var/log/caddy').glob('*') if x.is_file()] if pathlib.Path('/var/log/caddy').exists() else []
print(json.dumps(out))
PY
