ALTER TABLE sessions ADD COLUMN linked_session_id TEXT REFERENCES sessions(id);
