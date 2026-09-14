CREATE TABLE pim_activation_records (
  id TEXT PRIMARY KEY,
  assignment_key TEXT NOT NULL,
  eligibility_json TEXT NOT NULL CHECK(json_valid(eligibility_json)),
  status TEXT NOT NULL CHECK(status IN ('reserved','submitting','pending','active','failed','uncertain','expired','released')),
  provider_request_id TEXT,
  provider_assignment_id TEXT,
  ownership TEXT NOT NULL CHECK(ownership IN ('autopod','pre-existing','unconfirmed')),
  expires_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX pim_activation_current ON pim_activation_records(assignment_key)
  WHERE status IN ('reserved','submitting','pending','active','uncertain');
-- Deliberately independent of pod deletion: retention cannot erase another pod's shared lease.
CREATE TABLE pim_activation_leases (
  pod_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  activation_id TEXT NOT NULL REFERENCES pim_activation_records(id),
  requested_until TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(pod_id, request_id)
);
CREATE INDEX pim_leases_active ON pim_activation_leases(activation_id, released_at);
