CREATE TABLE managed_results (
    pod_id TEXT PRIMARY KEY REFERENCES managed_pods(pod_id),
    evidence_json TEXT NOT NULL DEFAULT '[]',
    limitations_json TEXT NOT NULL DEFAULT '[]',
    candidates_json TEXT NOT NULL DEFAULT '[]',
    source_json TEXT NOT NULL DEFAULT '[]'
);
