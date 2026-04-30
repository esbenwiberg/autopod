ALTER TABLE pods ADD COLUMN last_agent_event_at TEXT;
ALTER TABLE pods ADD COLUMN kicked_at TEXT;
ALTER TABLE pods ADD COLUMN kicked_reason TEXT;
