-- Add network_policy_resolved to pods: snapshot of the effective network policy applied
-- at provisioning time, after profile inheritance resolution.
--
-- ADR-020: snapshotted so historical aggregates are immutable even when
-- profiles.network_policy changes. Pre-migration pods stay NULL and bucket as
-- 'unknown' in the safety drill network-policy distribution.
--
-- Values: 'allow-all' | 'restricted' | 'deny-all' | NULL

ALTER TABLE pods ADD COLUMN network_policy_resolved TEXT DEFAULT NULL;
