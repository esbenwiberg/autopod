-- @execute-whole
CREATE TABLE logical_tasks (
  id TEXT PRIMARY KEY,
  root_pod_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE task_executions (
  pod_id TEXT PRIMARY KEY REFERENCES pods(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  parent_pod_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX task_executions_task ON task_executions(task_id);
CREATE TABLE task_agent_runs (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL REFERENCES task_executions(pod_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  binding TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT CHECK (outcome IN ('completed','failed','paused','stopped')),
  failure_category TEXT,
  UNIQUE (pod_id, generation, cycle)
);
-- Only resolvable historical lineages are assigned. Orphans/cycles remain visibly
-- unavailable and fail closed on execution; no guessed task identity or run history.
INSERT INTO logical_tasks (id, root_pod_id, created_at)
  SELECT 'task:' || id, id, created_at FROM pods WHERE linked_pod_id IS NULL;
WITH RECURSIVE lineage(pod_id, task_id) AS (
  SELECT root_pod_id, id FROM logical_tasks
  UNION ALL
  SELECT p.id, l.task_id FROM pods p JOIN lineage l ON p.linked_pod_id = l.pod_id
)
INSERT INTO task_executions (pod_id, execution_id, task_id, parent_pod_id, created_at)
  SELECT p.id, 'execution:' || p.id, l.task_id, p.linked_pod_id, p.created_at
  FROM lineage l JOIN pods p ON p.id = l.pod_id;
CREATE TRIGGER task_membership_immutable
BEFORE UPDATE OF linked_pod_id ON pods
WHEN NEW.linked_pod_id IS NOT OLD.linked_pod_id
  AND EXISTS (SELECT 1 FROM task_executions WHERE pod_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'task membership is immutable; create a distinct execution');
END;
CREATE TRIGGER task_run_settlement_immutable
BEFORE UPDATE ON task_agent_runs
WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.pod_id IS NOT OLD.pod_id
  OR NEW.generation IS NOT OLD.generation OR NEW.cycle IS NOT OLD.cycle
  OR NEW.binding IS NOT OLD.binding OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'task run identity and settlement are immutable');
END;
