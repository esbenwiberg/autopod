#!/bin/sh
set -eu
python3 - <<'PY'
import json,re,datetime,gzip,time,signal
from pathlib import Path
signal.alarm(40)
p=Path('/var/log/syslog');assert p.is_file() and not p.is_symlink() and p.stat().st_size<32*1024**2
counts={'windowLines':0,'nodeLines':0,'jsonObjects':0,'jsonParseFailures':0,'requestCompletedMentions':0,'unhandledErrorMentions':0,'podsRouteMentions':0};first=None;last=None;shapes={}
with p.open('rb') as f:
 for line in f:
  m=re.match(rb'^(\d{4}-\d\d-\d\dT[0-9:.+-]+)',line)
  if not m:continue
  stamp=m[1].decode();first=first or stamp;last=stamp
  if not ('2026-09-07T00:00:00'<=stamp<='2026-09-07T08:27:28'):continue
  counts['windowLines']+=1
  if not re.search(rb'\bnode\[\d+\]:',line):continue
  counts['nodeLines']+=1
  for text,key in [(b'request completed','requestCompletedMentions'),(b'Unhandled error','unhandledErrorMentions'),(b'/pods','podsRouteMentions')]:
   if text in line:counts[key]+=1
  i=line.find(b'{')
  if i<0:continue
  try:
   data=json.loads(line[i:])
   if isinstance(data,dict):
    counts['jsonObjects']+=1;kind=type(data.get('time')).__name__;shapes[kind]=shapes.get(kind,0)+1
  except ValueError:counts['jsonParseFailures']+=1
old=Path('/var/log/syslog.2.gz');total=0;tail=b'';deadline=time.monotonic()+20
with gzip.open(old,'rb') as f:
 while True:
  assert total<=448*1024**2 and time.monotonic()<deadline
  data=f.read(1024**2)
  if not data:break
  total+=len(data);tail=(tail+data)[-16384:]
stamps=[m[1].decode() for line in tail.splitlines() if (m:=re.match(rb'^(\d{4}-\d\d-\d\dT[0-9:.+-]+)',line))]
print(json.dumps({'syslogFirst':first,'syslogLast':last,'preReportWindow':counts,'applicationTimeShapes':shapes,'olderArchive':'syslog.2.gz','olderArchiveBytes':total,'olderArchiveLastTimestamp':stamps[-1] if stamps else None,'rawLogsExported':False},separators=(',',':')))
PY
