set -eu
python3 - <<'PY'
import subprocess,json,sqlite3
p=subprocess.run(['journalctl','-u','autopod-daemon','--since','2026-09-10 08:39:40 UTC','--until','2026-09-10 08:42:30 UTC','--no-pager','-o','json'],capture_output=True,timeout=15);assert len(p.stdout)<1024**2
rows=[]
for line in p.stdout.splitlines():
 try:j=json.loads(json.loads(line)['MESSAGE'])
 except (ValueError,TypeError):continue
 if isinstance(j,dict) and (j.get('podId')=='useful-dormouse' or j.get('sandboxId')):
  rows.append({k:j[k] for k in ['podId','sandboxId','containerId','msg','time','code'] if k in j})
out={'resourceEvents':rows[-18:]};db=sqlite3.connect('file:/data/autopod/autopod.db?mode=ro',uri=True,timeout=2)
for table in ['task_retry_attempts','pod_execution_claims','execution_leases','provider_attempts']:
 if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone():
  out[table+'Columns']=[r[1] for r in db.execute('PRAGMA table_info('+table+')')]
db.close();print(json.dumps(out))
PY
