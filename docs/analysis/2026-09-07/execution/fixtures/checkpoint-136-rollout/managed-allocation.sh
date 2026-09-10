set -eu
python3 - <<'PY'
import sqlite3,json,datetime
c=sqlite3.connect('file:/data/autopod/autopod.db?mode=ro',uri=True,timeout=2);c.row_factory=sqlite3.Row;c.execute('PRAGMA query_only=ON');out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
out['managed']=list(map(dict,c.execute("SELECT pod_id,state,runtime_ref,observed_exit,cleanup,created_at,json_extract(request_json,'$.effectiveGrant.budget.expiresAt') AS expiresAt,json_extract(request_json,'$.effectiveGrant.budget.maxDurationSeconds') AS duration FROM managed_pods WHERE state NOT IN ('complete','failed','killed') LIMIT 10")))
cols=[x[1] for x in c.execute('PRAGMA table_info(managed_sandbox_allocations)')];names=[x for x in ['pod_id','state','sandbox_id','container_id','created_at','updated_at','execution_spec_digest'] if x in cols];out['allocationColumns']=cols
out['allocations']=list(map(dict,c.execute('SELECT '+','.join(names)+' FROM managed_sandbox_allocations WHERE pod_id IN (?,?) LIMIT 10',('managed-49cb8e4f-15ca-41d3-b240-95a117ea9562','managed-7274cefa-4d4e-4694-83ac-8efe9c8cd445'))));print(json.dumps(out));c.close()
PY
