set -eu
python3 - <<'PY'
import sqlite3,json,time,datetime
ids=('managed-49cb8e4f-15ca-41d3-b240-95a117ea9562','managed-7274cefa-4d4e-4694-83ac-8efe9c8cd445')
for attempt in range(28):
 c=sqlite3.connect('file:/data/autopod/autopod.db?mode=ro',uri=True,timeout=2);c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON')
 rows=list(map(dict,c.execute('SELECT pod_id,state,runtime_ref,observed_exit,revoked,stop_requested FROM managed_pods WHERE pod_id IN (?,?)',ids)));c.close()
 if len(rows)==2 and all(r['state'] in ['complete','failed','killed'] and r['observed_exit']==1 for r in rows):break
 time.sleep(2)
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'priorReservations':rows}),flush=True)
assert len(rows)==2 and all(r['state'] in ['complete','failed','killed'] and r['observed_exit']==1 for r in rows),'existing reservations not yet terminal'
PY
python3 /data/autopod/rollout-136/cutover.py
