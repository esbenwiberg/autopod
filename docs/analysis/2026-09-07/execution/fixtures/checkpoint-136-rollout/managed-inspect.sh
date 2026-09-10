set -eu
python3 - <<'PY'
import sqlite3,json,datetime
c=sqlite3.connect('file:/data/autopod/autopod.db?mode=ro',uri=True,timeout=2);c.execute('PRAGMA query_only=ON');c.row_factory=sqlite3.Row
cols=[x[1] for x in c.execute('PRAGMA table_info(managed_pods)')];names=[x for x in ['id','pod_id','state','created_at','updated_at','profile_name','origin','sandbox_id','container_id','task_id'] if x in cols]
rows=c.execute('SELECT '+','.join(names)+" FROM managed_pods WHERE state NOT IN ('complete','failed','killed') LIMIT 10").fetchall();print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'columns':cols,'nonterminal':list(map(dict,rows))}));c.close()
PY
