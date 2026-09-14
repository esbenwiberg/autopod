CREATE TABLE series_launch_receipts (
  request_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  series_id TEXT NOT NULL UNIQUE,
  series_name TEXT NOT NULL,
  pods TEXT NOT NULL,
  created_at TEXT NOT NULL
);
