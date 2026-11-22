# #640 Opt-in XL and 2XL Azure Sandboxes — Implementation Plan

Research: `thoughts/shared/research/2026-11-22-640-sandbox-xl-tiers.md`.
Baseline `b01b2480a`, branch `local-pod/issues-1122/640`. No cloud calls, no migration.

## Overview

Replace the four separate “stops at L” definitions with **one ordered catalog**
(XS, S, M, L, XL, 2XL) that owns CPU, RAM and disk. Derive the tier type, default-tier
parsing, maximum, capabilities (including a human-readable bundle) and Azure create payload
from it. Keep `L` as the default and `2XL` as the maximum. Selecting 8 or 16 GiB picks the
whole XL or 2XL bundle through the existing launch allocation (`resolvedExecution.main.memoryGb`).
Close the legacy path that would silently round the implicit 10 GiB Docker default up to 2XL.

## Desired end state

| Selection | vCPU | RAM | Disk | Azure payload |
|---|---:|---:|---:|---|
| XS | 0.25 | 0.5 GiB | 5 GiB | `250m/512Mi/5Gi` (unchanged) |
| S | 0.5 | 1 GiB | 10 GiB | `500m/1024Mi/10Gi` (unchanged) |
| M | 1 | 2 GiB | 20 GiB | `1000m/2048Mi/20Gi` (unchanged) |
| **L (default)** | 2 | 4 GiB | 40 GiB | `2000m/4096Mi/40Gi` (unchanged) |
| XL | 4 | 8 GiB | 80 GiB | `4000m/8192Mi/80Gi` |
| 2XL (max) | 8 | 16 GiB | 160 GiB | `8000m/16384Mi/160Gi` |

- Capabilities advertise `memoryTiersGb: [0.5, 1, 2, 4, 8, 16]`, `maxMemoryGb: 16`,
  `defaults.memoryGb` = configured default (4), and a new `memoryBundles` list with labels
  such as `XL · 4 vCPU · 8 GiB RAM · 80 GiB disk`. `cpus`/`storageGb` stay `null`, so
  independent CPU/disk overrides are still rejected.
- An omitted size on a new launch freezes L (unchanged). 8/16 GiB freezes XL/2XL for that
  launch/profile only. 32 GiB, 3 GiB etc. fail at preview/admission (`ALLOCATION_UNSUPPORTED`).
- Both manager spawn paths (`spawn`, `ensureManagedContainer`) use the same resolver and
  refuse > 2XL **before** any claim or Azure request. No clamp, no fallback, no downgrade.
- A legacy sandbox pod with no memory setting gets the configured default tier, not 2XL.
- Desktop pickers and the preview/summary show the real bundle from capabilities.
- Operator docs explain the bundles, opt-in selection and cost.

## Decisions

1. **Catalog home:** new pure module `packages/daemon/src/containers/sandbox-tiers.ts`.
   `sandbox-api-client.ts` keeps re-exporting `SandboxResourceTier` for existing imports;
   its `SANDBOX_TIER_MEMORY_BYTES` / `MAX_SANDBOX_MEMORY_BYTES` / `pickSandboxTier` are
   removed and all callers move to the catalog (no duplicate table). Not in `@autopod/shared`:
   clients read bundles from capabilities, so no table copy is needed outside the daemon.
2. **Catalog shape:** `SANDBOX_TIERS = [{ tier, vcpu, memoryGiB, diskGiB }, …] as const`
   ordered ascending; `SandboxResourceTier = (typeof SANDBOX_TIERS)[number]['tier']`;
   `DEFAULT_SANDBOX_TIER = 'L'`; `MAX_SANDBOX_TIER` = last entry (`'2XL'`), kept as separate
   constants. Helpers: `sandboxTier(tier)`, `sandboxTierMemoryBytes(tier)`,
   `sandboxTierResources(tier)` (Azure units: `${vcpu*1000}m`, `${memoryGiB*1024}Mi`,
   `${diskGiB}Gi`), `sandboxTierLabel(tier)`, `parseSandboxTier(value)`,
   `resolveSandboxTier(memoryBytes, defaultTier)`.
3. **Resolver semantics (`resolveSandboxTier`):** no hint (`undefined`/≤0) → configured
   default; otherwise the smallest tier whose RAM ≥ request (preserves today’s XS–L
   round-up for legacy explicit values); above 2XL → throw
   `AutopodError(…, 'PREFLIGHT_INSUFFICIENT_MEMORY', 409)` naming the request and the 2XL
   ceiling. The launch API stays stricter: `resolve-execution.ts` already requires an exact
   advertised tier, so explicit new-launch selections never round.
4. **Default vs maximum:** the default remains `L` (`AZURE_SANDBOX_TIER` unset).
   `parseSandboxTier` is derived from the catalog (case-insensitive, normalized), so an
   operator *may* explicitly configure any catalog tier as the fleet default; we do not
   change the default and docs warn against raising it (see open question Q2).
5. **Capabilities contract:** add `memoryBundles: SandboxMemoryBundle[] | null` to shared
   `ExecutionCapabilities` (`{ tier, memoryGb, cpus, diskGb, label }`); Docker reports `null`.
   Do **not** populate `defaults.cpus/storageGb` or the resolved allocation with bundle CPU/disk:
   `assertCurrent` (`components.ts:212-229`) compares re-resolved digests, so changing those
   defaults would break recovery of every existing frozen sandbox launch.
6. **Persistence:** the choice is `resolvedExecution.main.memoryGb` (existing). No profile
   field, no migration. Recovery re-resolves the frozen value as an explicit request; it is
   never treated as omitted.
7. **Legacy implicit default:** new helper `containerMemoryRequestBytes(containerMemoryGb,
   target)` in `container-memory.ts`: explicit/frozen value → bytes (never reinterpreted);
   `null` + `sandbox` → `undefined` (manager resolves its configured default tier);
   `null` + `local` → 10 GiB (unchanged Docker behavior). Used by
   `provisioning-container.ts` spawn and `execution-preflight.ts` required-memory check
   (sandbox+null contributes no generic 10 GiB floor; declared minimums still apply).
8. **Managed path:** remove the hard-coded L guard in `ensureManagedContainer`; resolve the
   tier first (before the DB claim, discovery or create) and pass the same tier to
   `createSandbox`. Reuse/identity safeguards are untouched; a reused sandbox keeps its
   original size and no second allocation is created. Managed requests carry no size today;
   adding sizing to `ManagedPodRequest` is a non-goal.
9. **Azure:** `resourcesForTier` is replaced by `sandboxTierResources`. Create errors
   (quota/capacity) propagate unchanged; no code path retries with another tier.
10. **Agent instructions:** `resolveContainerMemory` reports the sandbox bundle for explicit
    sizes and “the daemon’s default sandbox bundle” for legacy omitted sizes; removes the
    “largest tier / cannot be raised by the profile / caps at” wording. Docker text unchanged.

## Non-goals

3XL (32 GiB) or anything above 2XL; Docker sizing changes; resizing running pods;
independent CPU/disk controls; inferring size from repo contents; raising the default;
sizing for managed/dispatcher `ManagedPodRequest`; persisting tier on
`managed_sandbox_allocations`; spikes/smoke scripts’ own tier tables; any cloud allocation,
deployment or the issue’s rollout check. Files owned by the concurrent pod
(`pods/repository-preparation.ts`, Docker archive methods, provider continuation) are not touched.

## Phase 1 — Catalog, Azure payload, manager spawn paths (daemon)

Files:
- **New** `packages/daemon/src/containers/sandbox-tiers.ts` (+ `sandbox-tiers.test.ts`).
- `containers/sandbox-api-client.ts`: drop tier table/clamp; `export type { SandboxResourceTier }`
  from catalog; update comments. Move/replace tier tests in `sandbox-api-client.test.ts`.
- `containers/azure-sandbox-api-client.ts`: `createSandboxFromDiskImage` uses
  `sandboxTierResources(options.tier)`; delete `resourcesForTier`.
- `containers/sandbox-container-manager.ts`: `spawn` and `ensureManagedContainer` call
  `resolveSandboxTier`; log tier + label; default comments (“default L; max 2XL”).
- `index.ts:554-559,639-640`: use catalog `parseSandboxTier`/`DEFAULT_SANDBOX_TIER`; warning
  lists catalog tiers. `configuration/host-components.ts:155`: `SandboxResourceTier`.

Tests:
- `sandbox-tiers.test.ts`: ordering; XS–L payloads byte-identical to baseline; XL/2XL
  payloads; labels; resolver (omitted→default, 1.5→M, 4→L, 6→XL, 8→XL, 16→2XL, 16.5 & 32
  throw); default ≠ max; parse (`xl`, `2XL`, invalid, `3XL` → undefined).
- `sandbox-container-manager.test.ts`: spawn 8/16 GiB → XL/2XL; 32 GiB rejects with zero
  creates; omitted → L / configured M. `ensureManagedContainer` 8/16 GiB → XL/2XL;
  32 GiB rejects before any claim row or create; lost-response retry at 16 GiB creates once
  and reuses (no duplicate, same tier).
- `azure-sandbox-api-client.test.ts`: XL and 2XL PUT bodies carry
  `4000m/8192Mi/80Gi` and `8000m/16384Mi/160Gi`; a managed 2XL create rejected with a
  quota/capacity error surfaces the error with exactly one sandbox PUT and no smaller payload.

## Phase 2 — Capabilities, admission and legacy fallback

Files:
- `packages/shared/src/types/launch-config.ts`: `SandboxMemoryBundle` +
  `ExecutionCapabilities.memoryBundles`; export from `shared/src/index.ts` if needed.
- `configuration/backend-capabilities.ts`: derive tiers/max/default/bundles from catalog;
  Docker `memoryBundles: null`. `test-utils/configuration-helpers.ts` fixture field.
- `containers/container-memory.ts`: `containerMemoryRequestBytes`; rewrite
  `resolveContainerMemory` around the catalog (no clamp).
- `pods/provisioning-container.ts:501-502`: `memoryBytes: containerMemoryRequestBytes(...)`
  (omit key when undefined).
- `pods/execution-preflight.ts:161-164`: same helper for `required`.
- `pods/system-instructions-generator.ts:887-900`: bundle-aware Resources text.

Tests:
- `backend-capabilities.test.ts`: tiers `[0.5,1,2,4,8,16]`, default 4 (L) separate from
  max 16, bundles/labels, cpus/storage null, Docker unchanged.
- `resolve-execution.test.ts` (sandbox caps from `sandboxCapabilities`): omitted → 4;
  8 → 8; 16 → 16; 32 and 3 → `ALLOCATION_UNSUPPORTED`; cpus/storage overrides rejected;
  re-resolving frozen 8/16 is digest-identical; caps lacking 16 reject rather than downgrade.
- **New** `containers/sandbox-tier-allocation.test.ts` (admission → resolved allocation →
  create payload): `sandboxCapabilities` → `resolveExecution` → `containerMemoryRequestBytes`
  → `SandboxContainerManager.spawn` and `.ensureManagedContainer` over an
  `AzureSandboxApiClient` with routed mocked `fetch`; asserts the PUT payload for XL/2XL,
  L for omitted settings, and the legacy null-memory path → L (not 2XL). If the managed
  post-create flow makes a routed fetch impractical, the managed half uses a recording client
  plus `sandboxTierResources` equality and the Azure payload is covered in Phase 1.
- `container-memory.test.ts`: helper cases incl. explicit 10 on sandbox stays 10 GiB
  (frozen value not reinterpreted) and null sandbox → `undefined`.
- `execution-preflight.test.ts`: sandbox + null memory + 4 GiB observed is not blocked;
  local + null still requires 10 GiB.
- `system-instructions-generator.test.ts`: update the sandbox expectations (bundle text, no
  “largest tier”); Docker case unchanged.
- If practical, `provisioning-container.test.ts`: legacy sandbox spawn omits `memoryBytes`;
  launch-backed spawn passes the frozen 16 GiB.

## Phase 3 — Desktop

Files (`packages/desktop`):
- **New** small helper (e.g. `Sources/AutopodUI/Views/Creation/ExecutionMemoryLabel.swift`):
  `label(memoryGb:backend:)` → bundle label from `backend["memoryBundles"]` when present,
  otherwise `"N GB"`.
- Pickers: `ConfigurationCollectionEditors.swift:135-140`, `LaunchConfigurationEditor.swift:206-212`,
  `ComposableCreatePodSheet.swift:396-402` use the helper; “· unavailable” rows unchanged.
- Preview/summary: `ComposableCreatePodSheet.swift:292` and
  `LaunchComposerSupport.swift:156-160` show the bundle for the previewed memory/target
  (same helper, from the resolved preview), so preview and launch agree.
- Legacy `ProfileEditorView.swift:1829-1880`: update mirrored ceiling (16) and the
  notice/help text (unset = sandbox default bundle; > 16 fails before allocation; values round
  up to the next bundle).
- Fixtures: `DesktopConfigurationFixtures.swift:178` and `LaunchComposerTests.swift:379` add
  sandbox `memoryBundles`.

Tests: `LaunchComposerTests` — helper labels for XL/2XL and fallback; context summary shows
`XL · 4 vCPU · 8 GiB RAM · 80 GiB disk` from a preview with 8 GiB sandbox.
Commands: `swift build --package-path packages/desktop`,
`swift test --package-path packages/desktop --filter LaunchComposerTests` (and
`scripts/test-desktop.sh` if time permits).

## Phase 4 — Docs and messages

- `docs/azure-container-apps-sandboxes.md`: “Resource bundles and large repositories” section:
  table, L default vs 2XL max, `AZURE_SANDBOX_TIER` is the fleet default (keep L), how one
  repository opts in (profile execution `{ target: 'sandbox', main: { memoryGb: 8 } }` or
  `ap run --memory-gb 16`), cost scales per running second (XL ≈ 2×, 2XL ≈ 4× L), 3XL not
  offered, no resizing, independent CPU/disk rejected, quota/capacity errors surface without
  fallback, rollout check still required before enabling for hosted users.
- `packages/daemon/CLAUDE.md:297`: `resolveSandboxTier` / catalog reference.
- CLI help: `--memory-gb` in `packages/cli/src/commands/launch.ts:390` and `series.ts:88`
  mention hosted-sandbox bundles (text only).

## Verification commands

```bash
npx pnpm --filter @autopod/shared build && npx pnpm --filter @autopod/shared typecheck
npx pnpm --filter @autopod/daemon exec vitest run src/containers/sandbox-tiers.test.ts \
  src/containers/sandbox-api-client.test.ts src/containers/azure-sandbox-api-client.test.ts \
  src/containers/sandbox-container-manager.test.ts src/containers/sandbox-tier-allocation.test.ts \
  src/containers/container-memory.test.ts src/configuration/backend-capabilities.test.ts \
  src/configuration/resolve-execution.test.ts src/pods/execution-preflight.test.ts \
  src/pods/system-instructions-generator.test.ts src/managed/sandbox-managed.test.ts \
  src/configuration/host-components.test.ts src/pods/provisioning-container.test.ts
npx pnpm --filter @autopod/daemon typecheck
npx pnpm --filter @autopod/cli typecheck   # if CLI text changes
npx pnpm lint
swift build --package-path packages/desktop
swift test --package-path packages/desktop --filter LaunchComposerTests
```

Broader daemon suite (`npx pnpm --filter @autopod/daemon test`) if time allows; failures
outside the touched areas are reported, not hidden.

## Open questions

- **Q1 (legacy explicit values):** a legacy (no launch config) sandbox profile with an explicit
  non-tier value above L (e.g. `containerMemoryGb: 10`, previously refused) will round up to
  2XL under the shared resolver. Plan: accept (explicit setting, same rule as XS–L). Alternative:
  require an exact tier above the default on the legacy path.
- **Q2 (operator default):** plan accepts any catalog tier for `AZURE_SANDBOX_TIER`
  (derived parsing). Alternative: restrict the configurable default to ≤ L.
