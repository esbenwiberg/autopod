-- Independent operator restrictions. Reusable preset edits never change admitted pod authority.
CREATE TABLE configuration_security_policy (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL CHECK(revision>0),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  updated_at TEXT NOT NULL
);
INSERT INTO configuration_security_policy VALUES(1,1,'{}',datetime('now'));
CREATE TABLE configuration_security_policy_history (
  revision INTEGER PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  actor_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
