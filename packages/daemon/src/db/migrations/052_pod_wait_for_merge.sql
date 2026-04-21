-- Gate stacked-series pods on merge (not just validation) before starting the next pod
ALTER TABLE pods ADD COLUMN wait_for_merge INTEGER NOT NULL DEFAULT 0;
