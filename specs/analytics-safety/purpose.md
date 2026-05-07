# Analytics Safety / Guardrails

## Problem
Autopod's runtime detects PII and prompt-injection patterns at seven untrusted-input
boundaries (action responses, MCP-proxy responses, issue body ingestion, CLAUDE.md
section fetches, skill content, free-text on POST /pods, event-bus payloads). Six of
those sites log the detection and move on; only the action-engine path persists into
`action_audit`, and even there `pii_detected` is a single boolean — we know "PII
fired" but not *which* pattern. The operator has no way to show "guardrails fired N
times this month, here's exactly which patterns and on which pods, audit chain
verified." The Safety story exists but is invisible.

## Outcome
The Safety card on the analytics dashboard surfaces fleet-wide guardrail-fire totals
over a trailing window; clicking it opens a drill with PII-by-pattern, the
quarantine-score histogram, an injection-attempts table by pod, an audit-chain
integrity widget, and the network-policy distribution.

## Users
Esben (operator) — tuning his own pod fleet. Operator-grade, not audit-grade.
The drill answers "are my guardrails working and what are they catching?", not
"can I attest to a regulator?". Locked by the master plan
(`docs/analytics-dashboard-plan.md` Audience section).

## Success signal
The operator can show another human, in three clicks from the analytics dashboard:
"guardrails fired N times this month, here's exactly which patterns and on which
pods, audit chain verified." Materialized by Brief 05's
`GET /pods/analytics/safety?days=30` (returns `summary`, `byPattern`, `byPod`,
`byKind`, `auditChain`, `networkPolicy`) and `POST /audit-chain/verify` (returns
`valid`, `totalPods`, `totalEntries`).

## Non-goals
- Audit-grade exports (PDF, retention guarantees, compliance attestation).
- Firewall iptables LOG → counters table (master plan defers).
- Container log retention (master plan defers).
- Auth failure / rate-limit / token-validation persistence.
- Backfill of historical injection detections — `safety_events` is forward-only.
  Pre-existing `action_audit` rows feed the PII histogram with a `pii_categories =
  NULL → 'unknown'` bucket.
- Mobile / web analytics surfaces — macOS only.
- Active blocking or response. The drill is read-only; quarantine and sanitize
  logic stay exactly as they are. This phase only adds *visibility*.
- Instrumentation of `event-bus.ts` content sanitization — it's wired but the
  `contentProcessing` option is not passed at `createEventBus(...)` in `index.ts:176`,
  so the branch is dead in production. Leave the hook in place for the day it's
  enabled; do not write to `safety_events` from there.

## Glossary
- **Guardrail-fire** — a single occurrence of `processContent` (or
  `processContentDeep`) finding ≥1 PII or injection pattern in untrusted text.
- **Detection source** — one of `action_response` | `mcp_proxy` | `issue_body` |
  `claude_md_section` | `skill_content` | `pod_input`. (`event_payload` is in
  the schema enum but unwired today.)
- **Kind** — `pii` | `injection`. Mirrors the two-step `processContent` pipeline
  (quarantine → sanitize) in `packages/shared/src/sanitize/processor.ts`.
- **Pattern name** — string from `PII_PATTERNS[].name` or
  `INJECTION_PATTERNS[].name` in `packages/shared/src/sanitize/patterns.ts`.
- **Severity** — `INJECTION_PATTERNS[].severity` (0..1) for `kind='injection'`
  rows; `NULL` for `kind='pii'` rows (PII patterns carry no severity).
- **Quarantine score** — pre-existing `action_audit.quarantine_score`, the max
  injection-pattern severity for a single action call. Histogram source.
- **Audit-chain integrity** — every `action_audit.entry_hash` matches
  `SHA-256(prev_hash || pod_id || action_name || params || response_summary ||
  quarantine_score || created_at)`. The new `pii_categories` column is
  **deliberately outside** this payload (see ADR-019).
- **Resolved network policy** — the effective network policy applied at pod
  provisioning time, after profile inheritance. Snapshotted on the `pods` row
  because `profiles.network_policy` is mutable (see ADR-020).
- **Terminal cohort** — the same filter Phases 1–3 use:
  `output_mode != 'workspace' AND status IN ('complete','killed','failed') AND
  completed_at IN window`. Applied to every section of the Safety drill, including
  the injection table and the network-policy distribution.

## Reversibility
This phase introduces durable schema (3 new tables + 2 new columns) and forward-only
data. Roll back as follows:

- Drop `safety_events`; drop `audit_chain_verifications`.
- `ALTER TABLE action_audit DROP COLUMN pii_categories` (SQLite supports DROP COLUMN
  since 3.35).
- `ALTER TABLE pods DROP COLUMN network_policy_resolved` (same).
- Revert the writer-site edits across the 6 sources (`actions/action-engine.ts`,
  `actions/audit-repository.ts`, `api/mcp-proxy-handler.ts`,
  `issue-watcher/issue-watcher-service.ts`, `pods/section-resolver.ts`,
  `pods/skill-resolver.ts`, `api/routes/pods.ts`, `pods/pod-manager.ts`).
- Hash chain unaffected — `pii_categories` was never in the hash payload (ADR-019).
- Desktop layer unblocks once the endpoints return: revert the analytics card
  extension and the drill view; existing analytics phases keep working.
