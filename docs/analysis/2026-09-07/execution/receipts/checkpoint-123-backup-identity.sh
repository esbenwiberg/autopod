#!/bin/sh
set -eu
python3 - <<'PY'
import os,stat,signal,json,sqlite3,hashlib,time
from pathlib import Path
root=Path('/data/autopod/backups')
old=root/'1788930281287.db'
r={'status':'incomplete','activeDatabaseOpened':False,'privateCopyCreated':False,'approvedSnapshotExists':old.exists(),'candidates':[]}
signal.signal(signal.SIGALRM,lambda *_: (_ for _ in ()).throw(TimeoutError()))
signal.alarm(60)
try:
    start=time.monotonic()
    entries=[]
    with os.scandir(root) as rows:
        for i,e in enumerate(rows):
            if i>=2048: raise ValueError('inventory_limit')
            if e.name.endswith('.db') and e.name[:-3].isdigit() and e.is_file(follow_symlinks=False):
                entries.append((int(e.name[:-3]),Path(e.path)))
    for _,p in sorted(entries,reverse=True)[:3]:
        s=p.lstat()
        row={'path':str(p),'bytes':s.st_size,'mtime':s.st_mtime_ns,'singleLink':s.st_nlink==1,'sidecarsAbsent':not Path(str(p)+'-wal').exists() and not Path(str(p)+'-journal').exists()}
        r['candidates'].append(row)
        if len(r['candidates'])==1 and s.st_nlink==1 and row['sidecarsAbsent'] and time.time()-s.st_mtime>120:
            h=hashlib.sha256()
            with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:
                for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
            row['sha256']=h.hexdigest()
            db=sqlite3.connect(p.as_uri()+'?mode=ro&immutable=1',uri=True,timeout=2)
            db.execute('pragma query_only=ON')
            db.set_progress_handler(lambda:1 if time.monotonic()-start>40 else 0,1000)
            row['schemaMaximum']=db.execute('select max(version) from schema_version').fetchone()[0]
            db.close()
            a=p.lstat();row['identityStable']=(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)==(a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns)
    v=os.statvfs(root);r['availableScratchBytes']=v.f_bavail*v.f_frsize
    r['status']='backup_metadata_observed'
except FileNotFoundError: r['failureCode']='required_path_missing'
except Exception: r['failureCode']='inspection_incomplete'
finally: signal.alarm(0)
print(json.dumps(r,separators=(',',':')))
PY
