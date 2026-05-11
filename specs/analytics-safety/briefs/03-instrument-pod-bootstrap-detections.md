---
title: "Instrument pod-bootstrap detections + network_policy_resolved"
depends_on: [ 01-add-safety-migrations-and-types, 02-add-safety-events-repository-and-action-writers ]
acceptance_criteria:
  - type: cmd
    outcome: rg -l 'safetyEventsRepo|safety_events' packages/daemon/src/pods/section-resolver.ts packages/daemon/src/pods/skill-resolver.ts → ≥2 matches (one per file)
    hint: rg -l 'safetyEventsRepo|safety_events' packages/daemon/src/pods/section-resolver.ts packages/daemon/src/pods/skill-resolver.ts
    polarity: expect-output
  - type: cmd
    outcome: rg -l 'network_policy_resolved|networkPolicyResolved' packages/daemon/src/pods/pod-manager.ts → ≥1 match
    hint: rg -l 'network_policy_resolved|networkPolicyResolved' packages/daemon/src/pods/pod-manager.ts
    polarity: expect-output
touches:
  - packages/daemon/src/pods/section-resolver.ts
  - packages/daemon/src/pods/section-resolver.test.ts
  - packages/daemon/src/pods/skill-resolver.ts
  - packages/daemon/src/pods/skill-resolver.test.ts
  - packages/daemon/src/pods/pod-manager.ts
  - packages/daemon/src/pods/pod-manager.test.ts
  - packages/daemon/src/pods/pod-repository.ts
  - packages/daemon/src/index.ts
does_not_touch:
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/safety/
  - packages/daemon/src/actions/
  - packages/daemon/src/api/
  - packages/daemon/src/issue-watcher/
  - packages/desktop/
---

## Task

Instrument the three pod-bootstrap detection sites and snapshot the
resolved network policy at provisioning. Three changes:

1. **`section-resolver.ts`** — at the existing `processContent` call
   on injected CLAUDE.md sections (line ~75), if PII or injection
   patterns fire, write per-pattern `safety_events` rows with
   `source='claude_md_section'`. Keep the log line. The sanitized
   content continues to flow into the container unchanged.

2. **`skill-resolver.ts`** — `sanitizeSkillContent` (line ~62)
   currently swallows the `processContent` result. Capture the threats
   + PII patterns and write per-pattern `safety_events` rows with
   `source='skill_content'`. Both call sites (line ~118, ~174) have
   pod context via the parent factory; if the pod_id is not in scope
   inside `sanitizeSkillContent`, plumb it through (one parameter, no
   refactor).

3. **`pod-manager.ts`** — at provisioning (after profile inheritance
   is resolved, just before container spawn — `pod-manager.ts:262-280`
   region), persist the resolved `network_policy` value to the new
   `pods.network_policy_resolved` column via the existing pod-update
   path. Add the field to `pod-repository.ts` row mapping +
   update SQL.

The repo from Brief 02 (`SafetyEventsRepository`) is the writer
target; receive it via DI from `index.ts`.

## Touches

- `packages/daemon/src/pods/section-resolver.ts` — add per-pattern
  `safety_events` writes around the `processContent` call. Keep the
  function signature consumer-compatible (it's already pure-ish).
- `packages/daemon/src/pods/section-resolver.test.ts` — extend.
- `packages/daemon/src/pods/skill-resolver.ts` — capture
  `processContent` result; write rows; if `pod_id` isn't in scope,
  thread it via `sanitizeSkillContent` parameter.
- `packages/daemon/src/pods/skill-resolver.test.ts` — extend.
- `packages/daemon/src/pods/pod-manager.ts` — write
  `network_policy_resolved` once profile inheritance is resolved.
  One-line update via the existing repo helper.
- `packages/daemon/src/pods/pod-manager.test.ts` — extend the
  provisioning test to assert the column is written.
- `packages/daemon/src/pods/pod-repository.ts` — extend `rowToPod`,
  INSERT, UPDATE for the new column. Single-line additions per
  surface.
- `packages/daemon/src/index.ts` — pass `safetyEventsRepo` into the
  three call sites that need it (section-resolver factory,
  skill-resolver factory, pod-manager).

## Does not touch

- `packages/daemon/src/db/migrations/` — Brief 01 owns.
- `packages/daemon/src/safety/` — Brief 02 owns the repository.
- `packages/daemon/src/actions/` — Brief 02 owns those writers.
- `packages/daemon/src/api/` — Brief 04 (POST /pods sanitization writer)
  and Brief 05 (analytics endpoint).
- `packages/daemon/src/issue-watcher/` — Brief 04.
- `packages/desktop/` — Brief 06.

## Constraints

- **Pod-id propagation**: every safety_events row written from this
  brief should carry the actual `pod_id`. These three sites all run
  during pod startup, so the id is available — plumb if needed but
  don't fall back to `NULL`.
- **Severity / payload_excerpt rules** (same as Brief 02):
  injection rows carry `INJECTION_PATTERNS[].severity`; PII rows
  carry `NULL`. `payload_excerpt` is the first 256 chars of the
  *post-sanitize* text. `null` allowed when the site has no readable
  text (not expected here — all three carry text).
- **One row per pattern hit** — same rule as Brief 02. Multi-pattern
  detections fan out into multiple rows.
- **`network_policy_resolved` values**: `'allow-all' | 'restricted' |
  'deny-all'`. Mirror the literal strings used by
  `docker-network-manager.ts` to avoid bucket drift in Brief 05's
  aggregator. Do not synthesize new strings.
- **Skill resolver is non-fatal** (`CLAUDE.md` "Skills are
  non-fatal"): if `safetyEventsRepo.insert(...)` throws, log and
  continue — don't drop the skill. The detection write must never
  block skill loading.
- **Section resolver is also non-fatal** for the same reason: write
  failures must not break section injection.
- **No transitions**: this brief writes log entries and one column.
  No state-machine code is touched. Don't bypass
  `validateTransition` (you shouldn't even be near it).
- **Repo path for the snapshot**: write via
  `podRepository.update(podId, { networkPolicyResolved: <value> })`
  — extend `update` if necessary. Don't reach into raw SQLite from
  `pod-manager.ts`.

## Test expectations

### `section-resolver`
- **Threats fire** — content with an injection pattern produces one
  `safety_events` row per pattern, `source='claude_md_section'`.
- **PII fires** — content with two PII patterns produces two
  `kind='pii'` rows.
- **Clean content** — no rows written. The existing happy path still
  returns the sanitized content unchanged.
- **Repo throw is swallowed** — mock the repo to throw on `insert`;
  the resolver still returns the sanitized content (regression
  guard).

### `skill-resolver`
- **Single skill with injection** — one row written; the skill is
  still injected into the container.
- **Multiple skills, mixed** — each skill's detections write
  independently; total row count matches the sum of patterns.
- **GitHub-fetched skill (timeout path)**: ensure the existing
  silent-drop behaviour still applies; no `safety_events` rows for
  skills that fail to fetch.

### `pod-manager`
- **Provisioning writes the column** — for a pod with a profile that
  resolves to `network_policy='restricted'`, after provisioning the
  `pods.network_policy_resolved` column equals `'restricted'`.
- **Inheritance** — a derived profile that overrides
  `network_policy` reflects the resolved (post-merge) value, not the
  base.
- **Recovery path doesn't re-stomp** — if `recoveryWorktreePath` is
  set and the pod is being resumed, `network_policy_resolved` should
  stay set to its original value (don't overwrite from the live
  policy). Easiest: only write when the column is NULL OR when this
  is the first provisioning. Add a regression test.

## Risks / pitfalls

- **Row attribution missing pod_id**: easy mistake when factoring
  through `sanitizeSkillContent` — if the helper signature isn't
  updated, the writer falls back to `null`. Test catches this.
- **Repo path drift**: the temptation to reach into raw SQLite from
  `pod-manager.ts` for a one-line column write. Don't — go through
  `pod-repository.ts`. The desktop layer already roundtrips pod data
  through this repo and a direct write would diverge from
  `rowToPod`.
- **Recovery / resume**: the second pass through provisioning on
  recovery would overwrite `network_policy_resolved` with the *live*
  policy value, which may have changed. ADR-020's whole point is the
  snapshot — guard the write.
- **Skill resolver fan-out**: multiple skills load in sequence. Don't
  batch their writes; one `insert` per pattern hit per skill keeps
  attribution clean.
- **Test infra**: `pod-manager.test.ts` already mocks
  `ContainerManager`, `Runtime`, etc. via factories from
  `mock-helpers.ts`. Wire `safetyEventsRepo` similarly. The
  provisioning test is the right anchor — don't write a new e2e.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run `./scripts/validate.sh`; build + lint + tests must pass.
3. Commit and push.
