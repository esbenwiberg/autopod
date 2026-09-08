-- Durable worker settlement is separate from lifecycle approval and delivery.
CREATE TABLE pod_finalizations (
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('running','awaiting_human','ready','preserving','finalizing','finished')),
  agent_settled_at TEXT,
  result TEXT,
  pending_decision_id TEXT,
  source_preserved_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pod_id, generation, cycle)
);
CREATE TABLE completion_decisions (
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL,
  response TEXT NOT NULL,
  actor TEXT NOT NULL,
  responded_at TEXT NOT NULL,
  PRIMARY KEY (pod_id, decision_id)
);
