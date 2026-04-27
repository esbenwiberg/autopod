-- Series-level design.md content (companion to series_description, which now
-- carries purpose.md content). Rendered as `## Design` in the agent's CLAUDE.md.
ALTER TABLE pods ADD COLUMN series_design TEXT;

-- Per-brief advisory scope hints. Stored as JSON string arrays.
-- The reviewer treats these as guidance, not enforcement: deviations are
-- flagged as discussion items in the diff review, never as build failures.
ALTER TABLE pods ADD COLUMN touches TEXT;
ALTER TABLE pods ADD COLUMN does_not_touch TEXT;
