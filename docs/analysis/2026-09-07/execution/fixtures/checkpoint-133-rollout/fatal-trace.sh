set -eu
python3 - <<'PY'
import subprocess,json,re
p=subprocess.run(['journalctl','-u','autopod-daemon','--since','2026-09-10 08:41:00 UTC','--until','2026-09-10 08:41:54 UTC','--no-pager','-o','json'],capture_output=True,timeout=15);assert len(p.stdout)<512*1024
items=[]
for line in p.stdout.splitlines():
 j=json.loads(line);m=j.get('MESSAGE','')
 try:json.loads(m);continue
 except (ValueError,TypeError):pass
 if isinstance(m,str):
  m=re.sub(r'(?i)(bearer\s+|token[=:]\s*)\S+',r'\1[REDACTED]',m)
  items.append(m[:450])
print(json.dumps({'unstructuredExitTrace':items[-24:]}))
PY
