-- Per-profile container memory limit (GB). NULL means no limit (Docker default).
ALTER TABLE profiles ADD COLUMN container_memory_gb REAL;
