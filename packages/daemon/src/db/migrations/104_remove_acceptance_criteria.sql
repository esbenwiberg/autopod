-- Remove the retired acceptance-criteria storage path.
-- Runnable specs now express verification through contract.yaml required_facts
-- plus human_review items.

ALTER TABLE watched_issues ADD COLUMN phase TEXT NOT NULL DEFAULT 'working';

UPDATE profiles
SET skip_validation_phases = (
  SELECT json_group_array(DISTINCT CASE value WHEN 'ac' THEN 'facts' ELSE value END)
  FROM json_each(profiles.skip_validation_phases)
)
WHERE skip_validation_phases IS NOT NULL
  AND json_valid(skip_validation_phases)
  AND EXISTS (
    SELECT 1
    FROM json_each(profiles.skip_validation_phases)
    WHERE value = 'ac'
  );

UPDATE validations
SET result = json_remove(result, '$.acValidation', '$.acSkipReason')
WHERE json_valid(result);

UPDATE pods
SET last_validation_result = json_remove(last_validation_result, '$.acValidation', '$.acSkipReason')
WHERE last_validation_result IS NOT NULL
  AND json_valid(last_validation_result);

ALTER TABLE pods DROP COLUMN acceptance_criteria;
ALTER TABLE pods DROP COLUMN ac_from;
ALTER TABLE pods DROP COLUMN ac_self_report;
ALTER TABLE profiles DROP COLUMN evaluate_plan;
