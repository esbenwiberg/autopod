ALTER TABLE pods ADD COLUMN infrastructure_failure TEXT NULL;
ALTER TABLE pods ADD COLUMN infrastructure_recovery_count INTEGER NOT NULL DEFAULT 0;
