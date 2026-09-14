-- @execute-whole
CREATE TABLE pod_goals (
  pod_id TEXT PRIMARY KEY REFERENCES pods(id) ON DELETE CASCADE,
  objective TEXT NOT NULL CHECK(length(objective) BETWEEN 1 AND 4000),
  state TEXT NOT NULL CHECK(state IN ('active','paused','achieved','blocked','budget-exhausted','cancelled','failed')),
  revision INTEGER NOT NULL DEFAULT 1,
  runtime TEXT NOT NULL CHECK(runtime IN ('codex','claude')),
  generation INTEGER,
  attempt_id TEXT,
  native_session_id TEXT,
  native_status TEXT,
  execution_stopped INTEGER NOT NULL DEFAULT 1 CHECK(execution_stopped IN (0,1)),
  control_intent TEXT CHECK(control_intent IN ('pause','resume','cancel')),
  last_sequence INTEGER NOT NULL DEFAULT -1,
  native_tokens_seen INTEGER NOT NULL DEFAULT 0,
  native_seconds_seen REAL NOT NULL DEFAULT 0,
  observed_tokens INTEGER NOT NULL DEFAULT 0,
  observed_seconds REAL NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_history_pod_goals AS SELECT * FROM pod_goals WHERE 0;
CREATE UNIQUE INDEX task_history_pod_goals_identity ON task_history_pod_goals(pod_id);
CREATE VIEW retained_pod_goals AS SELECT l.* FROM pod_goals l
  UNION ALL SELECT h.* FROM task_history_pod_goals h
  WHERE NOT EXISTS (SELECT 1 FROM pod_goals l WHERE l.pod_id=h.pod_id);
CREATE TRIGGER task_history_pod_goals_no_update BEFORE UPDATE ON task_history_pod_goals
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_pod_goals_no_delete BEFORE DELETE ON task_history_pod_goals
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
