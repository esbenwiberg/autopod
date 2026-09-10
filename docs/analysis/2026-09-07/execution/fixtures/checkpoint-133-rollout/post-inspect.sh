set -eu
python3 - <<'PY'
import json,pathlib,sqlite3,subprocess,datetime
root=pathlib.Path('/data/autopod/rollout-133');out={}
for name in ['staged-receipt','backup-receipt','pre-stop','stopped','activated']:
 p=root/(name+'.json');data=p.read_bytes();assert len(data)<12000;out[name]=json.loads(data)
db=sqlite3.connect('file:/data/autopod/autopod.db?mode=ro',uri=True,timeout=2)
out['database']={'schemaMaximum':db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0],'integrity':db.execute('PRAGMA integrity_check').fetchone()[0],'foreignKeyErrors':len(db.execute('PRAGMA foreign_key_check').fetchmany(10)),'pods':db.execute('SELECT count(*) FROM pods').fetchone()[0],'taskExecutions':db.execute('SELECT count(*) FROM task_executions').fetchone()[0],'drainExists':db.execute('SELECT count(*) FROM hosted_deploy_drain').fetchone()[0]};db.close()
p=subprocess.run(['journalctl','-u','autopod-daemon','--since','2026-09-10 08:34:00 UTC','-n','250','--no-pager','-o','json'],capture_output=True,timeout=15);assert len(p.stdout)<1024**2
errors=[]
for line in p.stdout.splitlines():
 try:j=json.loads(json.loads(line)['MESSAGE'])
 except Exception:continue
 if isinstance(j,dict) and isinstance(j.get('err'),dict):
  e=j['err'];errors.append({k:e.get(k) for k in ['type','message','code']});
  if isinstance(e.get('stack'),str):errors[-1]['frames']=e['stack'].splitlines()[1:5]
out['recentErrors']=errors[-5:]
text=json.dumps(out);assert len(text)<6500;print(text)
PY
