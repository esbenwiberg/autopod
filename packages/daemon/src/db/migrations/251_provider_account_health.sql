-- @execute-whole
-- Append-only observed provider account health (#566). The latest row per account is
-- authority. Unhealthy rows apply only to the credential generation they observed; a
-- credential write makes the account unknown again rather than deleting evidence.
CREATE TABLE provider_account_health_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ok', 'auth_revoked', 'out_of_credits')),
  source TEXT NOT NULL
    CHECK(source IN ('observed_failure', 'observed_success', 'operator_override')),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) = 64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1200),
  pod_id TEXT,
  actor TEXT CHECK(actor IS NULL OR length(actor) BETWEEN 1 AND 256),
  observed_at TEXT NOT NULL,
  CHECK((source = 'observed_failure') = (state != 'ok')),
  CHECK((source = 'operator_override') = (actor IS NOT NULL))
);
CREATE INDEX provider_account_health_latest
  ON provider_account_health_observations(account_id, id);
CREATE TRIGGER provider_account_health_no_update
BEFORE UPDATE ON provider_account_health_observations
BEGIN SELECT RAISE(ABORT, 'Provider account health observations are append-only'); END;
CREATE TRIGGER provider_account_health_no_delete
BEFORE DELETE ON provider_account_health_observations
BEGIN SELECT RAISE(ABORT, 'Provider account health observations are retained'); END;
