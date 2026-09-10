#!/bin/sh
set -eu
python3 - <<'CP132_ARCHIVE_READ'
"""Read fixed system-log archives; export only bounded metadata and route-correlated error classes."""
import datetime,gzip,json,os,re,signal,time
from pathlib import Path
START=datetime.datetime(2026,9,7,tzinfo=datetime.timezone.utc).timestamp()*1000
END=1788769648000
MAX_BYTES=32*1024**2

def route(entry):
 req=entry.get('req');value=entry.get('path') or (req.get('url') if isinstance(req,dict) else '')
 return next((p for p in ['/pods/analytics/cost','/pods'] if isinstance(value,str) and (value==p or value.startswith(p+'?'))),None)

def error_kind(entry):
 err=entry.get('err');err=err if isinstance(err,dict) else {};message=str(err.get('message',''));code=err.get('code');stack=str(err.get('stack',''))
 if code in ['SQLITE_FULL','SQLITE_CORRUPT','SQLITE_BUSY','SQLITE_ERROR','SQLITE_CANTOPEN','SQLITE_IOERR']:return code
 if 'JSON.parse' in stack or 'Unexpected token' in message:return 'JSON_PARSE'
 if code=='ERR_STRING_TOO_LONG' or 'Invalid string length' in message:return 'RESPONSE_SIZE'
 if err:return 'OTHER_ERROR'
 return None

def main():
 files=[];events=[];total=0
 for name in ['syslog','syslog.1','syslog.2.gz','syslog.3.gz','daemon.log','daemon.log.1']:
  p=Path('/var/log')/name;item={'name':name,'exists':p.exists()};files.append(item)
  if not p.exists():continue
  if p.is_symlink() or not p.is_file():item['refused']='not_regular';continue
  item['storedBytes']=p.stat().st_size;count=0;matched=0;incomplete=None
  opener=gzip.open if name.endswith('.gz') else open
  with opener(p,'rb') as f:
   while True:
    line=f.readline(min(65537,MAX_BYTES-total+1))
    if not line:break
    total+=len(line);count+=1
    if total>MAX_BYTES:incomplete='total_byte_bound';break
    if len(line)>65536:incomplete='line_bound';break
    i=line.find(b'{')
    if i<0:continue
    try:e=json.loads(line[i:])
    except (ValueError,TypeError):continue
    if not isinstance(e,dict):continue
    t=e.get('time')
    if not isinstance(t,(int,float)) or isinstance(t,bool) or not START<=t<=END:continue
    pid=e.get('pid');req=e.get('reqId');r=route(e);err=error_kind(e);res=e.get('res');status=e.get('status') or (res.get('statusCode') if isinstance(res,dict) else None)
    if type(pid) is not int or not isinstance(req,str) or len(req)>128:continue
    if not r and not err:continue
    matched+=1
    if len(events)>=10000:incomplete='event_bound';break
    events.append({'pid':pid,'request':req,'time':t,'route':r,'error':err,'status':status if type(status) is int else None})
  item.update(linesRead=count,matchedEntries=matched,incomplete=incomplete)
  if incomplete:break
 statuses={};errors={};correlated=0
 for e in events:
  if e['route'] and e['status']:
   k=e['route']+':'+str(e['status']);statuses[k]=statuses.get(k,0)+1
  if not e['error']:continue
  candidates={v['route'] for v in events if v['route'] and v['status']==500 and v['pid']==e['pid'] and v['request']==e['request'] and abs(v['time']-e['time'])<=30000}
  if len(candidates)==1:
   k=next(iter(candidates))+':'+e['error'];errors[k]=errors.get(k,0)+1;correlated+=1
 result={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'windowStartUTC':'2026-09-07T00:00:00Z','windowEndUTC':'2026-09-07T08:27:28Z','files':files,'decompressedBytesRead':total,'routeStatuses':statuses,'sameRequest500ErrorClasses':errors,'correlatedErrorEntries':correlated,'rawLogsExported':False}
 text=json.dumps(result,separators=(',',':'));assert len(text.encode())<=3500;print(text)
if __name__=='__main__':
 signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()));signal.alarm(45)
 try:main()
 except Exception as e:print(json.dumps({'status':'incomplete','errorClass':type(e).__name__}))

CP132_ARCHIVE_READ
