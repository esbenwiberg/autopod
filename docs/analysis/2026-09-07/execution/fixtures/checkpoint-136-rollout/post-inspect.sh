set -eu
python3 - <<'PY'
import json,pathlib,sqlite3,subprocess,datetime,hashlib
root=pathlib.Path('/data/autopod/rollout-136');out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
for name in ['backup-receipt','pre-stop','stopped','activated']:
 p=root/(name+'.json');assert p.stat().st_size<16000;out[name]=json.loads(p.read_text())
props=['MainPID','NRestarts','ExecMainCode','ExecMainStatus','ExecMainStartTimestamp','Result'];r=subprocess.run(['systemctl','show','autopod-daemon',*[x for p in props for x in ['-p',p]]],capture_output=True,text=True,timeout=10);out['service']=dict(x.split('=',1) for x in r.stdout.splitlines() if '=' in x)
pid=int(out['service']['MainPID']);out['cwd']=str((pathlib.Path('/proc')/str(pid)/'cwd').resolve());out['current']=str(pathlib.Path('/opt/autopod/current').resolve())
s=pathlib.Path('/data/autopod/autopod.db').stat();out['databaseIdentity']={'device':s.st_dev,'inode':s.st_ino}
db=sqlite3.connect('file:/data/autopod/autopod.db?mode=ro',uri=True,timeout=2);db.execute('PRAGMA query_only=ON')
out['database']={'schemaMaximum':db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0],'integrity':db.execute('PRAGMA integrity_check').fetchone()[0],'foreignKeyErrors':len(db.execute('PRAGMA foreign_key_check').fetchmany(10)),'pods':db.execute('SELECT count(*) FROM pods').fetchone()[0],'taskExecutions':db.execute('SELECT count(*) FROM task_executions').fetchone()[0],'drainRows':db.execute('SELECT count(*) FROM hosted_deploy_drain').fetchone()[0]};db.close()
text=json.dumps(out);assert len(text)<8000;print(text)
PY
