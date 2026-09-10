-- @execute-whole
CREATE TABLE task_history_events AS SELECT * FROM events WHERE 0;
CREATE UNIQUE INDEX task_history_events_identity ON task_history_events(id);
CREATE INDEX task_history_events_pod ON task_history_events(pod_id);
CREATE VIEW retained_events AS SELECT l.* FROM events l
  UNION ALL SELECT h.* FROM task_history_events h
  WHERE NOT EXISTS (SELECT 1 FROM events l WHERE l.id=h.id);
CREATE TRIGGER task_history_events_no_update BEFORE UPDATE ON task_history_events
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_events_no_delete BEFORE DELETE ON task_history_events
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TABLE task_history_session_progress_events AS SELECT * FROM session_progress_events WHERE 0;
CREATE UNIQUE INDEX task_history_session_progress_events_identity ON task_history_session_progress_events(id);
CREATE INDEX task_history_session_progress_events_pod ON task_history_session_progress_events(pod_id);
CREATE VIEW retained_session_progress_events AS SELECT l.* FROM session_progress_events l
  UNION ALL SELECT h.* FROM task_history_session_progress_events h
  WHERE NOT EXISTS (SELECT 1 FROM session_progress_events l WHERE l.id=h.id);
CREATE TRIGGER task_history_session_progress_events_no_update BEFORE UPDATE ON task_history_session_progress_events
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_session_progress_events_no_delete BEFORE DELETE ON task_history_session_progress_events
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_events_required_before_pod_delete BEFORE DELETE ON pods
WHEN EXISTS (SELECT 1 FROM events e WHERE e.pod_id=OLD.id AND NOT EXISTS
  (SELECT 1 FROM task_history_events h WHERE h.id=e.id))
 OR EXISTS (SELECT 1 FROM session_progress_events e WHERE e.pod_id=OLD.id AND NOT EXISTS
  (SELECT 1 FROM task_history_session_progress_events h WHERE h.id=e.id))
BEGIN SELECT RAISE(ABORT, 'pod deletion requires retained event history'); END;
