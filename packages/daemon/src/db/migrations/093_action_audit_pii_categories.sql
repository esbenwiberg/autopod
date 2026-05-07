-- Add pii_categories to action_audit: JSON array of PII pattern names detected in the
-- action response (e.g. '["api-key","email"]'). Populated forward by the action engine.
-- Pre-existing rows remain NULL and bucket as 'unknown' in the safety analytics breakdown.
--
-- ADR-019: pii_categories is deliberately OUTSIDE the audit-chain hash payload.
-- The hash is: SHA-256(prev_hash || pod_id || action_name || params || response_summary ||
-- quarantine_score || created_at). Adding pii_categories to the hash would invalidate all
-- existing chain entries. The analytics drill treats this as a best-effort enrichment, not
-- tamper evidence.

ALTER TABLE action_audit ADD COLUMN pii_categories TEXT DEFAULT NULL;
