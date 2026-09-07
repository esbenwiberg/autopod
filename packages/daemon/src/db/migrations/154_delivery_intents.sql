-- @execute-whole
CREATE TABLE delivery_intents (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  generation INTEGER NOT NULL,
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'creating', 'uncertain', 'delivered')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE delivery_receipts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE REFERENCES delivery_intents(id),
  pr_url TEXT NOT NULL UNIQUE,
  evidence TEXT NOT NULL CHECK (evidence IN ('create_response', 'provider_lookup')),
  disposition TEXT NOT NULL CHECK (disposition IN ('open', 'merged', 'closed')),
  result TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX delivery_intents_task ON delivery_intents(task_id, created_at);
CREATE TRIGGER delivery_receipts_immutable BEFORE UPDATE ON delivery_receipts
BEGIN SELECT RAISE(ABORT, 'delivery receipt is immutable'); END;
CREATE TRIGGER delivery_intents_identity_immutable BEFORE UPDATE OF identity, pod_id, task_id, generation, repository, branch, base_branch ON delivery_intents
BEGIN SELECT RAISE(ABORT, 'delivery identity is immutable'); END;

CREATE TABLE delivery_observations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id TEXT NOT NULL REFERENCES delivery_receipts(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('open', 'merged', 'closed')),
  observed_at TEXT NOT NULL
);
CREATE INDEX delivery_observations_receipt ON delivery_observations(receipt_id, sequence);
CREATE TRIGGER delivery_observations_immutable BEFORE UPDATE ON delivery_observations
BEGIN SELECT RAISE(ABORT, 'delivery observation is immutable'); END;
