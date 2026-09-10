-- @execute-whole
CREATE TABLE operator_guidance_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_operator_guidance_delivery_owner ON operator_guidance_deliveries(pod_id,generation,run_id);
CREATE TABLE operator_guidance_delivery_items (
  delivery_id TEXT NOT NULL REFERENCES operator_guidance_deliveries(id),
  message_id INTEGER NOT NULL,
  PRIMARY KEY(delivery_id,message_id)
);
CREATE TABLE operator_guidance_acknowledgments (
  delivery_id TEXT PRIMARY KEY REFERENCES operator_guidance_deliveries(id),
  acknowledged_at TEXT NOT NULL
);
CREATE TRIGGER operator_guidance_delivery_owner BEFORE INSERT ON operator_guidance_deliveries
WHEN NOT EXISTS (SELECT 1 FROM pods p JOIN task_executions e ON e.pod_id=p.id
  JOIN task_agent_runs r ON r.pod_id=p.id AND r.generation=p.lifecycle_generation
  WHERE p.id=NEW.pod_id AND e.task_id=NEW.task_id AND p.lifecycle_generation=NEW.generation
    AND r.id=NEW.run_id AND r.ended_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'operator guidance delivery requires current worker'); END;
CREATE TRIGGER operator_guidance_item_scope BEFORE INSERT ON operator_guidance_delivery_items
WHEN NOT EXISTS (SELECT 1 FROM operator_guidance_deliveries d JOIN nudge_messages n ON n.pod_id=d.pod_id
  WHERE d.id=NEW.delivery_id AND n.id=NEW.message_id AND n.consumed=0
    AND NOT EXISTS (SELECT 1 FROM operator_guidance_acknowledgments a WHERE a.delivery_id=d.id))
BEGIN SELECT RAISE(ABORT, 'operator guidance item scope mismatch'); END;
CREATE TRIGGER operator_guidance_ack_owner BEFORE INSERT ON operator_guidance_acknowledgments
WHEN NOT EXISTS (SELECT 1 FROM operator_guidance_deliveries d JOIN pods p ON p.id=d.pod_id
  JOIN task_agent_runs r ON r.id=d.run_id AND r.pod_id=p.id AND r.generation=p.lifecycle_generation
  WHERE d.id=NEW.delivery_id AND d.generation=p.lifecycle_generation AND r.ended_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'operator guidance acknowledgment belongs to a stale worker'); END;

-- Rollback code may not consume guidance merely by reading it.
CREATE TRIGGER operator_guidance_consume_ack BEFORE UPDATE ON nudge_messages
WHEN OLD.consumed=0 AND NEW.consumed<>0 AND NOT EXISTS (
  SELECT 1 FROM operator_guidance_delivery_items i
  JOIN operator_guidance_deliveries d ON d.id=i.delivery_id
  JOIN operator_guidance_acknowledgments a ON a.delivery_id=d.id
  WHERE i.message_id=OLD.id AND d.pod_id=OLD.pod_id)
BEGIN SELECT RAISE(ABORT, 'operator guidance requires delivery acknowledgment'); END;
CREATE TRIGGER operator_guidance_message_identity BEFORE UPDATE ON nudge_messages
WHEN NEW.id IS NOT OLD.id OR NEW.pod_id IS NOT OLD.pod_id OR NEW.message IS NOT OLD.message
 OR NEW.created_at IS NOT OLD.created_at OR (OLD.consumed<>0 AND
  (NEW.consumed IS NOT OLD.consumed OR NEW.consumed_at IS NOT OLD.consumed_at))
BEGIN SELECT RAISE(ABORT, 'operator guidance message and receipt are immutable'); END;
CREATE TRIGGER operator_guidance_delivery_no_update BEFORE UPDATE ON operator_guidance_deliveries
BEGIN SELECT RAISE(ABORT, 'operator guidance delivery is immutable'); END;
CREATE TRIGGER operator_guidance_delivery_no_delete BEFORE DELETE ON operator_guidance_deliveries
BEGIN SELECT RAISE(ABORT, 'operator guidance delivery is retained'); END;
CREATE TRIGGER operator_guidance_item_no_update BEFORE UPDATE ON operator_guidance_delivery_items
BEGIN SELECT RAISE(ABORT, 'operator guidance delivery item is immutable'); END;
CREATE TRIGGER operator_guidance_item_no_delete BEFORE DELETE ON operator_guidance_delivery_items
BEGIN SELECT RAISE(ABORT, 'operator guidance delivery item is retained'); END;
CREATE TRIGGER operator_guidance_ack_no_update BEFORE UPDATE ON operator_guidance_acknowledgments
BEGIN SELECT RAISE(ABORT, 'operator guidance acknowledgment is immutable'); END;
CREATE TRIGGER operator_guidance_ack_no_delete BEFORE DELETE ON operator_guidance_acknowledgments
BEGIN SELECT RAISE(ABORT, 'operator guidance acknowledgment is retained'); END;
