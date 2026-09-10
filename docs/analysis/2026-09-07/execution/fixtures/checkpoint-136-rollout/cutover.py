import datetime,json,os,pathlib,re,sqlite3,subprocess,time,urllib.request
ROOT=pathlib.Path('/data/autopod/rollout-136');DB=pathlib.Path('/data/autopod/autopod.db');OLD=pathlib.Path('/opt/autopod/releases/089442b6');NEW=pathlib.Path('/opt/autopod/releases/425ff91c');CURRENT=pathlib.Path('/opt/autopod/current');SHA='425ff91cd5e6347b32d21b69804ea4c02008bc8e';SERVICE='autopod-daemon'
def command(args,seconds=20):
 p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=seconds);assert p.returncode==0,'command failed';assert len(p.stdout)<65536;return p.stdout.decode().strip()
def record(name,v):
 p=ROOT/(name+'.json');fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(v,f)
def inspect():
 s=DB.stat();assert (s.st_dev,s.st_ino)==(2049,13107203)
 db=sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True,timeout=2);db.execute('PRAGMA query_only=ON');deadline=time.monotonic()+15;db.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
 try:
  counts={label:db.execute(q).fetchone()[0] for label,q in {
   'pods':"SELECT count(*) FROM pods WHERE status NOT IN ('complete','failed','killed')",
   'managed':"SELECT count(*) FROM managed_pods WHERE state NOT IN ('complete','failed','killed')",
   'systemRuns':"SELECT count(*) FROM system_sandbox_runs WHERE completed_at IS NULL OR (outcome='leaked' AND cleanup_state='retryable')",
   'schedules':"SELECT count(*) FROM scheduled_jobs WHERE enabled=1",
   'watchers':"SELECT count(*) FROM profiles WHERE issue_watcher_enabled=1",
   'podsitter':"SELECT count(*) FROM podsitter_config WHERE enabled=1"}.items()}
  print(json.dumps({'admissionCounts':counts}),flush=True)
  assert all(x==0 for x in counts.values()),'active work or dispatch remains'
  assert db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0]==183
  expiry=db.execute('SELECT expires_at FROM hosted_deploy_drain WHERE singleton=1').fetchone();assert expiry
  assert datetime.datetime.fromisoformat(expiry[0].replace('Z','+00:00'))>datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=15)
  return counts
 finally:db.close()
def main():
 assert CURRENT.resolve()==OLD
 assert command(['sudo','-u','ewi','git','-C',str(NEW),'rev-parse','HEAD'])==SHA
 assert command(['sudo','-u','ewi','git','-C',str(NEW),'status','--porcelain','--','packages','package.json','pnpm-lock.yaml','turbo.json'])==''
 assert os.statvfs('/data/autopod').f_bavail*os.statvfs('/data/autopod').f_frsize>10*1024**3
 pid=int(command(['systemctl','show',SERVICE,'-p','MainPID','--value']));assert pid>1
 proc=pathlib.Path('/proc')/str(pid);assert (proc/'cwd').resolve()==OLD/'packages/daemon'
 assert any((os.stat(p).st_dev,os.stat(p).st_ino)==(2049,13107203) for p in (proc/'fd').iterdir() if p.exists()),'service database mismatch'
 counts=inspect();record('pre-stop',{'counts':counts,'oldPid':pid,'oldRelease':str(OLD),'candidate':SHA,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 command(['systemctl','stop',SERVICE],90)
 assert command(['systemctl','show',SERVICE,'-p','MainPID','--value'])=='0'
 assert command(['systemctl','show',SERVICE,'-p','ActiveState','--value'])=='inactive'
 assert not proc.exists(),'original process not observed exited'
 inspect();record('stopped',{'observedExitedPid':pid,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 command(['sudo','-u','ewi','node',str(ROOT/'backup.mjs')],360)
 receipt=json.loads((ROOT/'backup-receipt.json').read_text());assert receipt['status']=='fresh_backup_and_upgrade_verified'
 inspect();assert CURRENT.resolve()==OLD
 pending=pathlib.Path('/opt/autopod/current.goal-136');assert not pending.exists() and not pending.is_symlink();pending.symlink_to(NEW);os.replace(pending,CURRENT)
 record('activation-intent',{'candidate':SHA,'backup':receipt['snapshot'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
 command(['systemctl','start',SERVICE],90)
 health=None
 for attempt in range(24):
  try:
   with urllib.request.urlopen('http://127.0.0.1:3100/health',timeout=3) as response:
    raw=response.read(65537);assert len(raw)<=65536;v=json.loads(raw);r=v['release'];assert r['commitSha']==SHA and r['dirty'] is False and r['source']=='build' and re.fullmatch('[a-f0-9]{64}',r['validationImplementationHash']);health=r;break
  except Exception:time.sleep(2)
 assert health,'candidate health identity unavailable'
 pid=int(command(['systemctl','show',SERVICE,'-p','MainPID','--value']));assert pid>1 and (pathlib.Path('/proc')/str(pid)/'cwd').resolve()==NEW/'packages/daemon'
 db=sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True);version=db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0];db.close();assert version==183
 out={'status':'activated','release':health,'schemaMaximum':version,'pid':pid,'oldPidObservedExited':True,'backup':receipt['snapshot'],'at':datetime.datetime.now(datetime.timezone.utc).isoformat()};record('activated',out);print(json.dumps(out))
if __name__=='__main__':
 try:main()
 except Exception as e:
  out={'status':'cutover_incomplete','errorClass':type(e).__name__,'stopped':(ROOT/'stopped.json').exists(),'activationAttempted':(ROOT/'activation-intent.json').exists()};print(json.dumps(out));raise SystemExit(1)
