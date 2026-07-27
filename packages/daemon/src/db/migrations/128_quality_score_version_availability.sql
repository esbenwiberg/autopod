-- Distinguish legacy quality-score semantics from the normalized activity algorithm.
-- Existing numeric columns remain intact for rollback. Availability controls whether
-- inspection-dependent values can be interpreted as measurements.

ALTER TABLE pod_quality_scores
  ADD COLUMN algorithm_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE pod_quality_scores
  ADD COLUMN inspection_availability TEXT NOT NULL DEFAULT 'unavailable'
    CHECK(inspection_availability IN ('available', 'unavailable'));

-- Version 2 uses nullable shadow columns so unavailable evidence is stored as
-- NULL without destructively changing the legacy non-null columns.
ALTER TABLE pod_quality_scores ADD COLUMN score_v2 INTEGER;
ALTER TABLE pod_quality_scores ADD COLUMN read_count_v2 INTEGER;
ALTER TABLE pod_quality_scores ADD COLUMN read_edit_ratio_v2 REAL;
ALTER TABLE pod_quality_scores ADD COLUMN edits_without_prior_read_v2 INTEGER;

CREATE INDEX IF NOT EXISTS idx_pqs_algorithm_availability
  ON pod_quality_scores(algorithm_version, inspection_availability, computed_at);
