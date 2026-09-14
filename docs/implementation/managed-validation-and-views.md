# Managed implementation validation and evidence views

Status: design approved on 2026-09-13. Evidence/UI foundation and the supervised deterministic execution boundary are implemented; user-facing production configuration is NOT connected. Do not merge or deploy this checkpoint before the dependencies below are resolved.

- Worktree: `/private/tmp/autopod-managed-validation-views`
- Branch: `codex/managed-validation-views`
- Base: freshly fetched `origin/main`, `f3ff60cf4188f8399ec935433c6f56521717b12e`.

## Agreed behavior

Regular and managed implementation pods share AutoPod's validation engine. Each lane retains its own orchestration. Dispatcher owns managed attempts, grants, correction decisions, acceptance and notifications; AutoPod executes validation, records evidence and performs authorized source delivery.

AutoPod validation is an explicit choice for each managed implementation attempt. A workflow/profile supplies the default; a launch override selects on or off. Resolve and freeze the effective choice before admission. Off means no AutoPod validation commands or reviewer calls, with the visible status `Disabled by configuration`. It must never appear as passed. Artifact integrity and Dispatcher independent verification for requested source delivery still apply.

Initial enabled mode supports deterministic phases. AI review is a subsequent capability with its own reviewed route and budget. Unsupported requested phases must be rejected at preflight with a clear reason, never silently removed. The initial implementation must distinguish missing commands, unavailable infrastructure and skipped phases from successful execution.

## Profile redesign integration

The other thread's current plan and uncommitted implementation were inspected in `/Users/ewi/repos/autopod` on 2026-09-13. They are work in progress, not dependencies available on this branch.

Relevant files:

- `thoughts/shared/plans/2026-09-13-composable-profiles.md`
- `packages/shared/src/types/launch-config.ts`: `EffectiveLaunchConfig`
- `packages/shared/src/schemas/launch-config.schema.ts`: workflow validation phases and typed launch overrides
- `packages/daemon/src/configuration/launch-resolver.ts`: immutable resolution and command validation
- `packages/daemon/src/configuration/snapshot-profile-adapter.ts`: temporary projection into the existing validation consumers

Use the redesign's ownership model:

| Input | Owner |
| --- | --- |
| Default validation phases | Workflow preset selected by the profile |
| Per-attempt enable/disable or phase override | Launch request, resolved before managed admission |
| Commands, timeouts and working directory | Repository setup |
| Toolchain and browser dependencies | Environment preset |
| Reviewer account/runtime/model | AI preset, constrained by managed authorization |
| Immutable configuration and provenance | Effective launch snapshot |
| Managed execution authority | Dispatcher grant and backend capability ceiling |

An explicit empty phase selection means validation off; omission inherits defaults. Keep the distinction through resolution and the managed execution spec. Do not add a competing validation field to the legacy Profile model. A UI on/off selector may map to the existing workflow override, provided it preserves the selected phase set when enabled and freezes the final selection.

Build a narrow validation configuration adapter from the resolved snapshot. It must not import native completion, merge, retries, fallback or escalation policy into the managed lifecycle. The managed `ProfileSnapshot` wire record is a separate contract from `EffectiveLaunchConfig`; define an explicit projection and bind the validation configuration digest into the accepted execution specification.

The redesign also edits `interfaces/validation-engine.ts` and `validation/local-validation-engine.ts` to inject an isolated reviewer executor. Preserve that integration when adding workspace support. Develop managed persistence, receipts and detail views independently; integrate the production configuration adapter after the redesign lands and is verified. Rebase before edits to shared composition and reviewer paths. Do not copy the other thread's uncommitted changes into this branch.

Migration numbers must be allocated from the combined current migration inventory at integration time. The other working tree currently has uncommitted migrations through 196. This checkpoint provisionally uses `197_managed_validations.sql`. Recheck and renumber on integration. The migration runner uses a high-water mark: deploying 197 ahead of the missing 186–196 series would cause those migrations to be skipped later. This branch must not be deployed independently of the profile migration series.

## Delivery sequence

1. Define the configuration projection, capability negotiation, managed validation receipt and on/off semantics. Preserve `validation.verifierPolicy` as the independent Dispatcher verifier policy. Do not reinterpret existing suite labels without explicit compatibility handling. Regenerate protocol types from the schema and verify AutoPod/Dispatcher conformance together.
2. Reuse AutoPod's resolved deterministic phase configuration and evidence semantics against a separate disposable candidate checkout at `/workspace`. A dedicated root-owned supervisor executes the exact selected commands as an unprivileged worker; this avoids coupling managed lifecycle recovery to the native engine's in-process orchestration and the overlapping reviewer redesign. Provision the validation resource under the existing attempt authority; do not rely on a daemon-only abort timer. Prove the recorded commit matches the source mounted read-only before allocation and after allocation, and reject changes to existing copied candidate files after validation. Do not inherit destructive reset behavior against an unfrozen worker workspace.
3. Add durable managed validation runs and phase records. Bind each receipt to pod, Dispatcher attempt, execution spec, resolved validation configuration and source commit/candidate identity. A digest establishes content identity; do not describe receipts as cryptographically signed unless signing is implemented.
4. Run the selected deterministic checks after observed worker exit and before making a candidate eligible for delivery. Disabled mode bypasses the runner and records the explicit configuration decision. Failed or interrupted validation retains diagnostic evidence and cannot deliver source. A frozen local candidate may exist before validation; freezing alone is not approval to publish it.
5. Reconcile validation across restarts with durable execution ownership. Unknown process termination blocks relaunch until reconciled. Fence work with revocation, stop and expiry checks. Artifact packaging must append evidence and preserve existing limitations instead of replacing validation evidence or clearing failures.
6. Extend Dispatcher to verify the receipt and exact bindings only when AutoPod validation was requested. Preserve independent artifact/source verification in both modes. Failed attempts produce attention; any correction follows Dispatcher retry policy as a new attempt. Carrying a failed candidate into a new attempt requires an explicit supported input contract.
7. Add a managed detail projection and validation history/receipt endpoints. Keep the fleet response compact. Use existing artifact receipt, manifest and download routes with installation ownership and integrity checks. Store bounded sanitized phase output and attachments separately from summary DTOs.
8. Extend mobile and desktop list/detail views with validation status, phase progress/results, artifact manifests/downloads, candidate and delivery evidence, limitations and timeline. Fetch a selected pod directly instead of fetching the entire fleet to locate it. Display off, not-run, running, passed, failed and infrastructure-unavailable distinctly.
9. Integrate with the profile redesign's landed snapshot/resolver interface, run cross-repository and UI checks, then enable a reviewed canary. AI review follows as a separate managed review attempt/capability with explicit provider and budget binding.

## View semantics

Keep AutoPod validation, artifact integrity and Dispatcher verification separately labeled. Show validation selection and its provenance, exact checked commit, per-phase duration and safe failure detail. Artifact cards show manifest files, byte counts, digests and download availability. Source cards show candidate and delivery receipts.

Dispatcher-owned verification state must be projected from a recorded authenticated receipt/status, not inferred from the pod's `validated` state. AutoPod currently only receives some verifier evidence during finalization; absent evidence must display unknown/not received. If failed or pending Dispatcher verification is required in this view, add an explicit bounded status synchronization contract. Viewing or downloading evidence must not start workers or change workflow state.

## Acceptance criteria

- The same implementation can be launched with validation on or off; explicit off survives profile edits, restart and replay.
- On runs the configured deterministic checks and requires their evidence. Off invokes no checks, reads `Disabled by configuration`, and is accepted under the corresponding Dispatcher policy.
- Missing, stale, mismatched or incomplete required evidence prevents acceptance; failed commands and unavailable infrastructure remain distinguishable.
- Changing source after validation invalidates the binding and prevents delivery.
- Native validation/rework/delivery behavior remains covered by regression tests.
- Restart, stop, revocation and expiry do not duplicate validation or source effects, and preserve evidence already recorded.
- Artifact packaging does not overwrite validation records or erase limitations. Failure diagnostics remain inspectable even when delivery is blocked.
- Both UIs show the same receipt-backed status, enforce ownership, retain useful stale data during transient errors and handle direct detail navigation. Verify mobile layout and native desktop rendering.
- Local tests, CI, UI checks and the live sandbox canary are reported separately. Unrun acceptance is not a pass.

## Work isolation

The original checkout contains the other thread's active profile changes and the existing Draw.io diagram. It remains untouched. This branch begins from published main and contains only this feature's work. Before cross-repository code changes, create a corresponding isolated Dispatcher worktree and inspect its repository instructions.

## Implementation checkpoint — 2026-09-14

Implemented:

- Additive wire choice `validation.autopod`, modes `off` / `deterministic`, frozen configuration digest, capability negotiation and strict digest-bound validation receipts. Legacy requests retain their semantics.
- Durable run claim, receipt/phase persistence, independent source-delivery gate, grant checks after observed worker exit, stop/revocation/expiry fencing, no automatic replay of an uncertain run after restart, and receipt/evidence updates in one transaction.
- An injected validation port must report exact selected phases. An overall pass without every selected phase passing is rejected. Explicit off records disabled and runs no validator.
- A concrete supervised port now provisions a dedicated digest-bound managed resource with the same pinned image, repository enrollment, network ceiling and attempt deadline. It mounts the frozen candidate read-only, copies it to disposable `/workspace`, runs only configured setup/lint/SAST/build/test commands as UID/GID 1000 with no-new-privileges, and emits bounded phase status/duration receipts.
- The validation supervisor is root-owned, detached and one-start. Its durable receipt binds the execution spec, configuration, candidate and commit. Stop/revocation/expiry terminate the child process group; daemon restart reconciles the same resource rather than replaying commands. Source mutation, command failure and infrastructure unavailability remain distinct.
- Validation cleanup must be observed before source delivery. A transient cleanup failure blocks delivery but restart retries cleanup without rerunning a passed validation. Production profile-set composition still supplies no validation configuration, so deterministic admission remains dark until the profile adapter lands.
- Worker artifacts remain inspectable if subsequent validation fails. Artifact evidence and prior limitations are retained.
- Passive installation-scoped detail/receipt endpoints; desktop and mobile validation summaries/phases, source and independent verifier evidence, artifact manifests and authenticated downloads, and a bounded recent timeline. Direct detail fetches do not load the fleet. Arbitrary artifact files are not rendered as active HTML.
- Dispatcher verifies receipt integrity and exact attempt, configuration, candidate and commit bindings in both modes, before invoking its existing independent source finalizer.

Not implemented / not accepted yet:

- The landed `EffectiveLaunchConfig` projection, inherited workflow default and per-attempt launch selector. Raw protocol on/off selection is implemented; user-facing launch integration is not.
- The landed `EffectiveLaunchConfig` adapter and a reviewed production binding. No shadow profile fields were added; without an explicit binding, capability discovery does not advertise deterministic validation.
- Container-backend integration and live canary proof for local Docker and hosted Sandbox/ACI. Unit tests prove the supervisor and composition contracts, but live firewall enforcement, UID availability, dependency image contents and remote cleanup still require environment evidence.
- Native browser/health/pages/facts phases and AI review. The supervised initial backend intentionally accepts only setup/lint/SAST/build/test; requesting unsupported phases fails preflight rather than silently skipping them.
- Durable phase-output attachments and diagnostic logs. Current views expose safe phase status, duration, internal reason codes and limitations, not raw command output.
- Visual rendering/device acceptance, CI, full validation pipeline and reviewed live sandbox canary. AI review remains outside this increment.

Local evidence:

- Managed/native validation regression sweep: 525 tests, 37 files.
- Supervised runner/runtime focused suite: 23 tests, including one-start execution, caller loss, restart reconciliation, stop/revocation/expiry, source mutation, stale configuration, dependency-cache trust, observed cleanup and no-rerun recovery.
- Shared managed protocol: 37 tests passed.
- Mobile managed detail/store: 5 tests passed, including direct navigation, explicit off, and manifest inspection.
- Desktop `swift test --filter ManagedPod`: app compiled; 4 tests passed, including authenticated direct detail decoding.
- Dispatcher targeted driver/coordinator/source/protocol/validation suite: 72 tests passed. A broader run including copied `test_grants_v2.py` has a stale test expecting the previous request/time schema ceilings; that test was not weakened or modified.
- Shared package build passes. Daemon ESM packaging passes and copies `validation-supervisor.py` byte-for-byte into `dist/runtime`. The declaration build stops at unchanged `src/runtimes/run-claude-cli.ts:153` (`SpawnOptions | undefined` overload); complete daemon diagnostics contain no errors on this feature's changed managed production paths. Mobile full typecheck reports errors in unchanged `DispatchPreflightPanel.test.tsx:106` and `ValidationSummary.test.tsx:173`. Neither package-wide typecheck is claimed green.

Dispatcher isolation: `/private/tmp/dispatcher-managed-validation-views`, branch `codex/managed-validation-views`, base `0c8c6cacb9b47e3a2a3ad33f744d4d9857eee510`. Its existing managed implementation is untracked in the original repository. Relevant baseline modules/tests/protocol were copied to this isolated worktree for compatibility checks. They are NOT all new work authored by this feature and must not be blindly staged/published. New feature work there is the validation gate/helper/tests, capability preflight additions, optional-field generator fix, and protocol regeneration. The original Dispatcher checkout is unchanged.

Next integration order: land/review the profile redesign and Dispatcher managed baseline; rebase and allocate a non-conflicting migration; connect the frozen configuration/launch choice to the supervised port; complete container/UI/live acceptance; only then enable deterministic validation for reviewed attempts. No additional product decision is needed for the on/off requirement.
