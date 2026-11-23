-- Policy changes create new revisions; a preview never rewrites saved authority.
CREATE TABLE saved_delegation_policy_revisions (
  owner_digest TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  payload_digest TEXT NOT NULL,
  PRIMARY KEY (owner_digest, policy_id, revision)
) WITHOUT ROWID;

CREATE TRIGGER saved_delegation_policy_revision_immutable
BEFORE UPDATE ON saved_delegation_policy_revisions
BEGIN SELECT RAISE(ABORT, 'saved delegation policy revisions are immutable'); END;
CREATE TRIGGER saved_delegation_policy_revision_retained
BEFORE DELETE ON saved_delegation_policy_revisions
BEGIN SELECT RAISE(ABORT, 'saved delegation policy revisions are retained'); END;
