#!/bin/sh
set -eu
python3 - <<'CP132_READ_ONLY'
"""Bounded read-only release readiness and pre-report journal coverage.
No service change, database writes, tokens, prompts, raw code or raw logs exported.
"""
import datetime,hashlib,json,os,re,selectors,signal,sqlite3,subprocess,time
from pathlib import Path

def command(args,limit=8192,seconds=10):
 data=bytearray();reason=None
 with subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={**os.environ,'GIT_OPTIONAL_LOCKS':'0'}) as p:
  with selectors.DefaultSelector() as sel:
   sel.register(p.stdout,selectors.EVENT_READ);deadline=time.monotonic()+seconds
   while True:
    if time.monotonic()>=deadline:reason='timeout';break
    if not sel.select(.1):continue
    chunk=os.read(p.stdout.fileno(),min(65536,limit+1-len(data)))
    if not chunk:break
    data.extend(chunk)
    if len(data)>limit:reason='byte_limit';break
  if reason:p.kill()
  try:p.wait(timeout=2)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=2);reason=reason or 'exit_timeout'
 return bytes(data[:limit]),{'exit':p.returncode,'incomplete':reason,'bytes':len(data)}

def journal_projection(raw):
 count=0;first=None;last=None;parsed=0;route_counts={};error_classes={}
 for line in raw.splitlines():
  try:entry=json.loads(line)
  except (ValueError,TypeError):continue
  count+=1;t=entry.get('__REALTIME_TIMESTAMP')
  if isinstance(t,str) and t.isdigit():
   t=int(t);first=min(first,t) if first else t;last=max(last,t) if last else t
  try:message=json.loads(entry.get('MESSAGE',''))
  except (ValueError,TypeError):continue
  if not isinstance(message,dict):continue
  parsed+=1;req=message.get('req');res=message.get('res');url=message.get('path') or (req.get('url') if isinstance(req,dict) else '')
  route=next((x for x in ['/pods/analytics/cost','/pods'] if isinstance(url,str) and (url==x or url.startswith(x+'?'))),None)
  code=message.get('status') or (res.get('statusCode') if isinstance(res,dict) else None)
  if route and type(code) is int:
   k=route+':'+str(code);route_counts[k]=route_counts.get(k,0)+1
  err=message.get('err');text=str(err.get('message','')) if isinstance(err,dict) else ''
  kind=next((label for phrase,label in [('database or disk is full','SQLITE_FULL'),('Unexpected token','JSON_PARSE'),('Invalid string length','RESPONSE_SIZE')] if phrase in text),None)
  if kind and route:error_classes[route+':'+kind]=error_classes.get(route+':'+kind,0)+1
 return {'journalEntries':count,'parsedApplicationEntries':parsed,'firstMicros':first,'lastMicros':last,'routeStatuses':route_counts,'directRouteErrorClasses':error_classes}

def inspect():
 raw,st=command(['systemctl','show','autopod-daemon','--property=MainPID','--value']);assert st['exit']==0 and raw.strip().isdigit();pid=int(raw);assert pid>1
 proc=Path('/proc')/str(pid);cwd=proc.joinpath('cwd').resolve(strict=True);assert re.fullmatch(r'/opt/autopod/(?:managed/)?releases/[a-f0-9]{8,40}/packages/daemon',str(cwd));release=cwd.parents[1]
 result={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pid':pid,'serviceCwd':str(cwd),'loadedBytesAttested':False}
 current=Path('/opt/autopod/current').resolve(strict=True);result['currentMatchesService']=current==release
 raw,st=command(['systemctl','show','autopod-daemon','--property=ExecMainStartTimestamp','--value']);value=raw.decode().strip();result['serviceStartedAt']=value if st['exit']==0 and re.fullmatch(r'[A-Za-z0-9 :+.-]{1,80}',value) else None
 git=['git','-c','safe.directory='+str(release),'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',str(release)]
 raw,st=command(git+['rev-parse','HEAD']);result['checkoutSha']=raw.decode().strip() if st['exit']==0 and re.fullmatch(rb'[a-f0-9]{40}\s*',raw) else None
 _,st=command(git+['diff','--no-ext-diff','--no-textconv','--quiet','HEAD','--']);result['checkoutDirty']=bool(st['exit']) if st['exit'] in [0,1] else None
 result['entryBundles']=[]
 for name in ['index.js','managed.js']:
  p=cwd/'dist'/name
  if p.is_file() and not p.is_symlink():
   info=p.stat();assert info.st_size<=8*1024**2;data=p.read_bytes();result['entryBundles'].append({'name':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'mtimeNs':info.st_mtime_ns})
 database=Path('/data/autopod/autopod.db');assert not database.is_symlink();info=database.stat();identity=(info.st_dev,info.st_ino);matched=False
 with os.scandir(proc/'fd') as fds:
  for i,fd in enumerate(fds):
   assert i<2048
   try:s=os.stat(fd.path);matched=matched or (s.st_dev,s.st_ino)==identity
   except OSError:pass
 result['activeDatabase']={'device':identity[0],'inode':identity[1],'serviceFdMatched':matched,'bytes':info.st_size};assert matched
 db=sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=1)
 try:
  db.execute('PRAGMA query_only=ON');deadline=time.monotonic()+5;db.set_progress_handler(lambda:int(time.monotonic()>deadline),1000)
  result['schemaMaximum']=db.execute('SELECT MAX(version) FROM schema_version').fetchone()[0]
  statuses=['provisioning','running','awaiting_input','paused','validating','validated','review_required','approved','merging','merge_pending','killing']
  result['restartBlockingCounts']={status:db.execute('SELECT count(*) FROM pods WHERE status=?',(status,)).fetchone()[0] for status in statuses}
  result['queuedCount']=db.execute("SELECT count(*) FROM pods WHERE status='queued'").fetchone()[0]
 finally:db.close()
 result['freeBytes']=os.statvfs('/data/autopod').f_bavail*os.statvfs('/data/autopod').f_frsize
 # This window predates the original goal creation and report, unlike the later errors previously available.
 raw,st=command(['journalctl','-u','autopod-daemon','--since','2026-09-07 00:00:00 UTC','--until','2026-09-07 08:27:28 UTC','-n','10000','--no-pager','-o','json'],2*1024**2,10)
 result['preReportJournal']={**st,**journal_projection(raw),'windowEndUTC':'2026-09-07T08:27:28Z'}
 raw,st=command(['journalctl','-u','autopod-daemon','--since','2026-09-07 00:00:00 UTC','--until','2026-09-08 00:00:00 UTC','--no-pager','-o','json'],2*1024**2,10)
 projection=journal_projection(raw);result['reportDayCoverage']={**st,**projection}
 result['serviceStableAtEnd']=proc.joinpath('cwd').resolve(strict=True)==cwd and database.stat().st_ino==identity[1]
 return result

def main():
 signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()));signal.alarm(50)
 try:result=inspect()
 except Exception as e:result={'status':'incomplete','errorClass':type(e).__name__}
 finally:signal.alarm(0)
 text=json.dumps(result,separators=(',',':'));assert len(text.encode())<=3500;print(text)
if __name__=='__main__':main()

CP132_READ_ONLY
