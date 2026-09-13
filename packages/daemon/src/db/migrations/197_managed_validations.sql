-- Integrate after the composable-profile migration series through 196.
-- Do not deploy this migration ahead of that series: schema_version uses a high-water mark.
CREATE TABLE managed_validations (
  pod_id TEXT PRIMARY KEY REFERENCES managed_pods(pod_id),
  validation_id TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL,
  container_id TEXT,
  cleanup TEXT NOT NULL DEFAULT 'not-requested'
);
