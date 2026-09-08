CREATE TABLE managed_provider_allowances (
    pod_id TEXT NOT NULL REFERENCES managed_pods(pod_id),
    operation_key TEXT NOT NULL,
    route_digest TEXT NOT NULL,
    grant_revision INTEGER NOT NULL,
    reserved_tokens INTEGER NOT NULL,
    actual_tokens INTEGER,
    state TEXT NOT NULL CHECK(state IN ('reserved','observed')),
    PRIMARY KEY(pod_id,operation_key)
);
