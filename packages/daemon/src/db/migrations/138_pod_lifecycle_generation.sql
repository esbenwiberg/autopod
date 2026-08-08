ALTER TABLE pods ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation > 0);
