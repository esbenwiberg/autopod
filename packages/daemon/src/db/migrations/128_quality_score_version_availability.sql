-- Distinguish legacy quality-score semantics from the normalized activity algorithm.
-- Existing numeric columns remain intact for rollback. Availability controls whether
-- inspection-dependent values can be interpreted as measurements.

ALTER TABLE pod_quality_scores
  ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE pod_quality_scores
  ADD COLUMN inspection_availability TEXT NOT NULL DEFAULT 'unavailable'
    CHECK(inspection_availability IN ('available', 'unavailable'));

CREATE INDEX IF NOT EXISTS idx_pqs_algorithm_availability
  ON pod_quality_scores(algorithm_version, inspection_availability, computed_at);
