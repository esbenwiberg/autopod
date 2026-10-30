-- @execute-whole
-- No historical classification. Only new explicit frozen contracts opt in.
ALTER TABLE pods ADD COLUMN completion_policy TEXT CHECK(completion_policy IS NULL OR completion_policy = 'accept-findings');
ALTER TABLE pods ADD COLUMN research_findings TEXT CHECK(research_findings IS NULL OR json_valid(research_findings));
ALTER TABLE task_history_pods ADD COLUMN completion_policy TEXT;
ALTER TABLE task_history_pods ADD COLUMN research_findings TEXT;
-- Retain each reviewed cycle and its first acceptance across pod reuse/deletion.
CREATE TABLE research_findings_receipts (
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  accepted INTEGER NOT NULL CHECK(accepted IN (0,1)),
  receipt TEXT NOT NULL CHECK(json_valid(receipt)),
  PRIMARY KEY(pod_id,generation,cycle,accepted)
);
CREATE TRIGGER research_findings_receipts_no_update BEFORE UPDATE ON research_findings_receipts
BEGIN SELECT RAISE(ABORT,'Findings receipts are immutable'); END;
CREATE TRIGGER research_findings_receipts_no_delete BEFORE DELETE ON research_findings_receipts
BEGIN SELECT RAISE(ABORT,'Findings receipts are immutable'); END;
CREATE TRIGGER research_findings_record AFTER UPDATE OF research_findings ON pods
WHEN NEW.research_findings IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO research_findings_receipts VALUES (
    NEW.id, json_extract(NEW.research_findings,'$.generation'),
    json_extract(NEW.research_findings,'$.cycle'),
    json_type(NEW.research_findings,'$.acceptance') != 'null', NEW.research_findings
  );
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM research_findings_receipts WHERE pod_id=NEW.id
      AND generation=json_extract(NEW.research_findings,'$.generation')
      AND cycle=json_extract(NEW.research_findings,'$.cycle')
      AND accepted=(json_type(NEW.research_findings,'$.acceptance') != 'null')
      AND receipt=NEW.research_findings
  ) THEN RAISE(ABORT,'Findings receipt conflicts with retained evidence') END;
END;
