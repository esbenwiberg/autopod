-- Audit hash chain: tamper-evident linked-list for action_audit rows.
--
-- prev_hash: SHA-256 of the previous row's entry_hash (NULL for the first row per pod).
-- entry_hash: SHA-256(prev_hash || pod_id || action_name || params || response_summary || quarantine_score || created_at).
--
-- Immutability is enforced at the application layer (audit-repository has no update/delete
-- methods). verifyAuditChain() can detect any row that was tampered with directly.

ALTER TABLE action_audit ADD COLUMN prev_hash TEXT DEFAULT NULL;
ALTER TABLE action_audit ADD COLUMN entry_hash TEXT DEFAULT NULL;
