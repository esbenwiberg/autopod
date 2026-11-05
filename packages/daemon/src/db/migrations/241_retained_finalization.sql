-- @execute-whole
-- Refuse a partial release that omits the targeted-retry migration. The runner
-- tracks MAX(version), so silently jumping over 237 would prevent later repair.
SELECT rewrite_repair FROM task_retry_authorizations LIMIT 0;
-- No cascade: finalization custody outlives mutable pod/resource pointers.
CREATE TABLE retained_finalizations (
  pod_id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  binding TEXT NOT NULL CHECK(json_valid(binding)),
  receipt TEXT NOT NULL CHECK(json_valid(receipt)),
  stop_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(stop_dispatched IN (0,1)),
  delivery_evidence TEXT CHECK(delivery_evidence IS NULL OR json_valid(delivery_evidence))
);
CREATE TABLE retained_finalization_resources (
  pod_id TEXT NOT NULL REFERENCES retained_finalizations(pod_id),
  container_id TEXT NOT NULL,
  PRIMARY KEY(pod_id, container_id)
);
CREATE INDEX retained_finalization_resource_identity ON retained_finalization_resources(container_id);
CREATE TRIGGER retained_finalization_identity_immutable
BEFORE UPDATE ON retained_finalizations
WHEN NEW.pod_id<>OLD.pod_id OR NEW.request_key<>OLD.request_key
  OR NEW.request_hash<>OLD.request_hash OR NEW.binding<>OLD.binding
  OR NEW.stop_dispatched<OLD.stop_dispatched
  OR json_extract(NEW.receipt,'$.request')<>json_extract(OLD.receipt,'$.request')
  OR json_extract(NEW.receipt,'$.actor')<>json_extract(OLD.receipt,'$.actor')
  OR json_extract(NEW.receipt,'$.createdAt')<>json_extract(OLD.receipt,'$.createdAt')
  OR json_extract(OLD.receipt,'$.state')='finalized'
BEGIN SELECT RAISE(ABORT,'Retained finalization identity and finalized receipt are immutable'); END;
CREATE TRIGGER retained_finalization_no_delete BEFORE DELETE ON retained_finalizations
BEGIN SELECT RAISE(ABORT,'Retained finalization custody cannot be deleted'); END;
CREATE TRIGGER retained_finalization_resource_no_delete BEFORE DELETE ON retained_finalization_resources
BEGIN SELECT RAISE(ABORT,'Retained finalization resources cannot be released'); END;
CREATE TRIGGER retained_finalization_resource_no_update BEFORE UPDATE ON retained_finalization_resources
BEGIN SELECT RAISE(ABORT,'Retained finalization resources are immutable'); END;
