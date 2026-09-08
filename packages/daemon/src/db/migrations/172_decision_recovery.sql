-- Retain decision context and a local event-order fence across reply/restart races.
ALTER TABLE completion_decisions ADD COLUMN generation INTEGER;
ALTER TABLE completion_decisions ADD COLUMN question TEXT;
ALTER TABLE completion_decisions ADD COLUMN event_watermark INTEGER NOT NULL DEFAULT 0 CHECK(event_watermark >= 0);
-- Legacy replies lack trustworthy transport ordering. Conservatively require a
-- new completion after upgrade before reusing settlement for those pods.
UPDATE completion_decisions SET event_watermark = COALESCE(
  (SELECT MAX(id) FROM events WHERE events.pod_id = completion_decisions.pod_id), 0
);
