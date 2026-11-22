-- Retain the exact dispatched integration digest without rewriting prior selections.
-- Historical jobs have no digest and remain subject to the no-resend boot fence.
ALTER TABLE parent_qualification_jobs ADD COLUMN input_digest TEXT
  CHECK(input_digest IS NULL OR (
    length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND
    substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'
  ));

CREATE TRIGGER parent_qualification_input_digest_immutable
BEFORE UPDATE OF input_digest ON parent_qualification_jobs
WHEN NOT (OLD.input_digest IS NULL AND NEW.input_digest IS NOT NULL
          AND OLD.status='reserved' AND NEW.status='checks')
BEGIN SELECT RAISE(ABORT,'parent qualification input digest is immutable'); END;
