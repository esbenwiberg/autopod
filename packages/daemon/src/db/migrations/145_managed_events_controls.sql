ALTER TABLE managed_pods ADD COLUMN active_grant_json TEXT;
UPDATE managed_pods SET active_grant_json=json_extract(request_json,'$.effectiveGrant');
CREATE TABLE managed_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    pod_id TEXT NOT NULL REFERENCES managed_pods(pod_id),
    event_key TEXT NOT NULL,
    event_json TEXT NOT NULL,
    UNIQUE(pod_id,event_key)
);
CREATE TABLE managed_controls (
    pod_id TEXT NOT NULL REFERENCES managed_pods(pod_id),
    operation_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    result_json TEXT,
    PRIMARY KEY(pod_id,operation_key)
);
