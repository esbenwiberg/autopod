set -eu
python3 - <<'PY'
import sqlite3,json,datetime
c=sqlite3.connect('file:/data/autopod/autopod.db?mode=ro',uri=True,timeout=2);c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON')
rows=c.execute("SELECT pod_id,dispatcher_installation_id,dispatcher_attempt_id,state,runtime_ref,revoked,stop_requested,observed_exit,cleanup,consumed_tokens,created_at,json_extract(active_grant_json,'$.expiresAt') AS expiresAt,json_extract(active_grant_json,'$.deadline') AS deadline FROM managed_pods WHERE state NOT IN ('complete','failed','killed') LIMIT 10").fetchall();print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'managed':list(map(dict,rows))}));c.close()
PY
