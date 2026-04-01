-- Per-profile build and test phase timeouts (seconds). NULL = use defaults (300s / 600s).
ALTER TABLE profiles ADD COLUMN build_timeout INTEGER;
ALTER TABLE profiles ADD COLUMN test_timeout INTEGER;
