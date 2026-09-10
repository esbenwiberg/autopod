set -eu
python3 - <<'PY'
import json,subprocess
p=subprocess.run(['journalctl','-u','autopod-daemon','--since','2026-09-10 09:03:15 UTC','-n','80','--no-pager','-o','json'],capture_output=True,timeout=15);assert len(p.stdout)<1024**2
out=[]
for line in p.stdout.splitlines():
 try:j=json.loads(json.loads(line)['MESSAGE'])
 except Exception:continue
 if isinstance(j,dict) and isinstance(j.get('err'),dict):
  e=j['err'];out.append({'msg':j.get('msg'),'code':e.get('code'),'message':e.get('message'),'frames':str(e.get('stack','')).splitlines()[1:4]})
print(json.dumps(out[-5:]))
PY
