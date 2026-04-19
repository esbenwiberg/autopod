-- Enable fan-in series dependencies (a pod can wait on multiple parents).
-- The array is stored as a JSON string. Parse with JSON.parse on read.
-- The legacy single-value depends_on_pod_id column is kept in sync as the
-- first element of depends_on_pod_ids for back-compat readers.
ALTER TABLE pods ADD COLUMN depends_on_pod_ids TEXT;

-- Backfill existing single-parent rows into the new array column.
UPDATE pods
  SET depends_on_pod_ids = json_array(depends_on_pod_id)
  WHERE depends_on_pod_id IS NOT NULL AND depends_on_pod_ids IS NULL;
