#!/bin/sh
set -eu
python3 - <<'PY'
import gzip,json,re,struct
from pathlib import Path
out=[]
for name in ['syslog','syslog.1','syslog.2.gz','syslog.3.gz','daemon.log','daemon.log.1']:
 p=Path('/var/log')/name;r={'name':name,'exists':p.exists()};out.append(r)
 if not p.is_file() or p.is_symlink():continue
 r['storedBytes']=p.stat().st_size
 if name.endswith('.gz'):
  with open(p,'rb') as f:f.seek(-4,2);r['gzipISizeModulo4GiB']=struct.unpack('<I',f.read(4))[0]
 with (gzip.open(p,'rb') if name.endswith('.gz') else open(p,'rb')) as f:data=f.read(8192)
 stamps=[]
 for line in data.splitlines():
  match=re.match(rb'^(\d{4}-\d\d-\d\dT[0-9:.+-]+|[A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d)',line)
  if match:stamps.append(match[1].decode())
 r['prefixFirstTimestamp']=stamps[0] if stamps else None;r['prefixLastTimestamp']=stamps[-1] if stamps else None
print(json.dumps(out,separators=(',',':')))
PY
