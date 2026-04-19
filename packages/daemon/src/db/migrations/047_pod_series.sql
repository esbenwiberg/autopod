ALTER TABLE pods ADD COLUMN depends_on_pod_id TEXT REFERENCES pods(id);
ALTER TABLE pods ADD COLUMN series_id TEXT;
ALTER TABLE pods ADD COLUMN series_name TEXT;
ALTER TABLE pods ADD COLUMN dependency_started_at TEXT;
