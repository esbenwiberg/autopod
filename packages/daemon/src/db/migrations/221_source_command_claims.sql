-- @execute-whole
-- One immutable admission/receipt of each kind for a source-operation step.
-- Repeated error observations never imply an exit or permit replay.
CREATE UNIQUE INDEX source_command_step_evidence
ON source_adoption_events(adoption_id,json_extract(event,'$.step'),json_extract(event,'$.observation'))
WHERE json_extract(event,'$.observation') IN (
  'source-command-claimed','source-command-admitted','source-command-started',
  'source-command-exited','source-command-unsent-revoked'
);
