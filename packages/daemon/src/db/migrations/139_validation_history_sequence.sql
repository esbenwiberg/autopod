ALTER TABLE validations ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE validations ADD COLUMN cycle INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY pod_id
      ORDER BY created_at ASC, rowid ASC
    ) AS next_sequence
  FROM validations
)
UPDATE validations
SET sequence = (
  SELECT next_sequence
  FROM ranked
  WHERE ranked.id = validations.id
);

WITH ordered AS (
  SELECT
    id,
    pod_id,
    sequence,
    attempt,
    LAG(attempt) OVER (
      PARTITION BY pod_id
      ORDER BY sequence ASC
    ) AS previous_attempt
  FROM validations
), cycled AS (
  SELECT
    id,
    SUM(
      CASE
        WHEN previous_attempt IS NOT NULL AND attempt <= previous_attempt THEN 1
        ELSE 0
      END
    ) OVER (
      PARTITION BY pod_id
      ORDER BY sequence ASC
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS next_cycle
  FROM ordered
)
UPDATE validations
SET cycle = (
  SELECT next_cycle
  FROM cycled
  WHERE cycled.id = validations.id
);

CREATE UNIQUE INDEX idx_validations_pod_sequence
  ON validations(pod_id, sequence);

CREATE INDEX idx_validations_pod_cycle_attempt
  ON validations(pod_id, cycle, attempt);
