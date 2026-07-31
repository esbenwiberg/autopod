-- Process-health score v3.
--
-- V3 separates trajectory/process evidence from outcome quality, records when
-- inspection telemetry is ambiguous, and normalizes file-based penalties with
-- a distinct-modified-file denominator. V1/V2 columns remain untouched so
-- historical scores retain their original semantics.
ALTER TABLE pod_quality_scores ADD COLUMN score_v3 INTEGER;
ALTER TABLE pod_quality_scores ADD COLUMN read_count_v3 INTEGER;
ALTER TABLE pod_quality_scores ADD COLUMN read_edit_ratio_v3 REAL;
ALTER TABLE pod_quality_scores ADD COLUMN edits_without_prior_read_v3 INTEGER;
ALTER TABLE pod_quality_scores ADD COLUMN modified_file_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pod_quality_scores ADD COLUMN ambiguous_inspection_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pod_quality_scores ADD COLUMN inspection_unavailable_reason TEXT;
