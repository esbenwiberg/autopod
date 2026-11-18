-- A missing runtime reference is not proof that an async allocation never started.
-- Old rows did not journal that boundary; unknown is the conservative default.
ALTER TABLE managed_pods ADD COLUMN allocation_attempted INTEGER NOT NULL DEFAULT 1 CHECK(allocation_attempted IN (0,1));
