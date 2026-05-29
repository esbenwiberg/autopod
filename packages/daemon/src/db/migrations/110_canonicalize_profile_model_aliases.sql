UPDATE profiles
SET default_model = CASE default_model
  WHEN 'opus' THEN 'claude-opus-4-8'
  WHEN 'sonnet' THEN 'claude-sonnet-4-6'
  WHEN 'haiku' THEN 'claude-haiku-4-5'
  ELSE default_model
END
WHERE default_model IN ('opus', 'sonnet', 'haiku');

UPDATE profiles
SET reviewer_model = CASE reviewer_model
  WHEN 'opus' THEN 'claude-opus-4-8'
  WHEN 'sonnet' THEN 'claude-sonnet-4-6'
  WHEN 'haiku' THEN 'claude-haiku-4-5'
  ELSE reviewer_model
END
WHERE reviewer_model IN ('opus', 'sonnet', 'haiku');

UPDATE profiles
SET escalation_config = json_set(
  escalation_config,
  '$.askAi.model',
  CASE json_extract(escalation_config, '$.askAi.model')
    WHEN 'opus' THEN 'claude-opus-4-8'
    WHEN 'sonnet' THEN 'claude-sonnet-4-6'
    WHEN 'haiku' THEN 'claude-haiku-4-5'
    ELSE json_extract(escalation_config, '$.askAi.model')
  END
)
WHERE escalation_config IS NOT NULL
  AND json_valid(escalation_config)
  AND json_extract(escalation_config, '$.askAi.model') IN ('opus', 'sonnet', 'haiku');
