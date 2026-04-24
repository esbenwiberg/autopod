-- Extend pod_quality_scores with new behavioural signals:
--   edit_churn_count  — distinct files with 3+ modify events (thrashing indicator)
--   pr_fix_attempts   — number of PR fix cycles the pod went through
--   validation_passed — 1 if smoke tests passed, 0 if failed, NULL if no validation ran
ALTER TABLE pod_quality_scores ADD COLUMN edit_churn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pod_quality_scores ADD COLUMN pr_fix_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pod_quality_scores ADD COLUMN validation_passed INTEGER;
