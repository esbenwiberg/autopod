# Handover — dear-otter (Brief 03: Pod-Bootstrap Writers + Network Policy Snapshot)

## What was built

Three instrumentation sites + one type-safe column snapshot.

### 1. `section-resolver.ts` — CLAUDE.md section safety events
At the `processContent` call on fetched section content, writes per-pattern `safety_events` rows:
- Injection threats (`processed.threats`) → `kind='injection'`, `source='claude_md_section'`, `severity` from `ThreatIndicator`
- PII-only (`processed.sanitized && processed.threats.length === 0`) → `kind='pii'`, `source='claude_md_section'`, `severity=null`, patterns from `collectPiiPatternNames(rawText)` (pre-sanitize)
- `payload_excerpt` = first 256 chars of post-sanitize text, or `null` if empty
- Non-fatal: `repo.insert` throws → warn + continue; sanitized content still flows through
- `podId` required to write; if missing, writes are skipped entirely
- Changed from conditional sanitization (only when `options?.contentProcessing` was set) to always-on using `DEFAULT_CONTENT_PROCESSING`, so events fire even when the caller passes no options

`ResolveSectionsOptions` now carries `safetyEventsRepo?: SafetyEventsRepository` and `podId?: string`. The function signature is backward-compatible (all new fields optional).

### 2. `skill-resolver.ts` — skill content safety events
`sanitizeSkillContent` went from 1 parameter to 5: `(content, skillName, podId, safetyEventsRepo, logger)`. Same injection/PII fanout as section-resolver, `source='skill_content'`. Pod_id threaded from `resolveSkills(skills, logger, podId?, safetyEventsRepo?)` → `resolveOne` → `resolveLocal` / `resolveGithub` → `sanitizeSkillContent`.

Guard: `podId ? safetyEventsRepo : undefined` — if no pod_id, repo is not passed to `sanitizeSkillContent`, preventing NULL-attributed rows from these sites. Skills that fail to fetch never reach `sanitizeSkillContent`, so no safety rows for timeout/error paths.

`resolveSkills` public API: `resolveSkills(skills, logger, podId?, safetyEventsRepo?)` — backward-compatible, existing call sites without the new params continue to work.

### 3. `pod-manager.ts` — network_policy_resolved snapshot
After `podRepo.update(podId, { profileSnapshot })`, writes the resolved network policy:
```ts
if (!pod.networkPolicyResolved) {
  const resolvedNetworkPolicy = profile.networkPolicy?.enabled
    ? (profile.networkPolicy.mode ?? 'restricted')
    : 'allow-all';
  podRepo.update(podId, { networkPolicyResolved: resolvedNetworkPolicy });
}
```
Guard `!pod.networkPolicyResolved` ensures recovery/resume doesn't overwrite the original snapshot (ADR-020). The `pod` object is read from DB before provisioning starts so the guard reflects DB state.

Default fallback: when `networkPolicy` is absent or disabled → `'allow-all'`. When enabled but `mode` is absent → `'restricted'`.

### 4. `pod-repository.ts` + `pod.ts` type improvements
- `networkPolicyResolved` typed as `NetworkPolicyMode | null` (not `string | null`) throughout
- `PodUpdates.networkPolicyResolved?: NetworkPolicyMode | null`
- `rowToSession`: casts to `NetworkPolicyMode` from SQLite text
- `Pod.networkPolicyResolved: NetworkPolicyMode | null` in shared types

### 5. DI wiring (`index.ts`)
`safetyEventsRepo` passed into `createPodManager(...)`. Already wired to `makeActionEngine` and `createServer` by Brief 02 — this brief adds the `createPodManager` wiring only.

## Deviations from brief

- **Always-sanitize in section-resolver**: The brief said "at the existing processContent call" implying it was already always called. In fact, the original code only sanitized when `options?.contentProcessing` was set. Since `pod-manager.ts` calls `resolveSections(mergedSections, logger)` with no options, the old code would never have sanitized or fired safety events. Fixed by introducing `DEFAULT_CONTENT_PROCESSING` as a fallback (same config as skill-resolver), so the path is always-on. This is a correct fix, not a scope expansion.

- **`NetworkPolicyMode | null` instead of `string | null`**: Strengthened the type after simplify review flagged the stringly-typed field. Does not change wire format or DB values.

## Files owned — do not modify without good reason

- `packages/daemon/src/pods/section-resolver.ts` — all DI and safety event logic here
- `packages/daemon/src/pods/skill-resolver.ts` — sanitizeSkillContent signature change
- `packages/daemon/src/pods/pod-repository.ts` — `networkPolicyResolved` field mapping
- `packages/shared/src/types/pod.ts` — `Pod.networkPolicyResolved` type

## Contract notes for downstream pods

### For Brief 04 (issue-watcher, POST /pods):
- `SafetyEventsRepository.insert()` returns `number` (rowid) — use this for `attachPodId` in issue-watcher
- `safetyEventsRepo` is passed to `createPodManager` — Brief 04 touches `createServer` deps but not `createPodManager`, so no conflict

### For Brief 05 (analytics endpoint):
- `pods.network_policy_resolved` values: `'allow-all' | 'restricted' | 'deny-all'` — NULL for pre-migration pods (bucket as 'unknown')
- The `NetworkPolicyMode` type in `@autopod/shared` is the canonical set of valid values; don't add new strings without updating the type

### For Brief 06 (desktop):
- `Pod.networkPolicyResolved: NetworkPolicyMode | null` is exported from `@autopod/shared` — Swift Codable model should mirror `String?` with value space `allow-all | restricted | deny-all | null`

## Discovered landmines

- **Semicolons in SQL migration comments** break `createTestDb()` (documented in envious-cardinal handover). Not hit in this brief but still applies to future migrations.
- **section-resolver conditional sanitization**: The old guard `if (options?.contentProcessing)` was a latent bug — any future caller that doesn't pass content-processing config would silently skip safety events. The always-on path (with DEFAULT_CONTENT_PROCESSING fallback) is the correct invariant.
