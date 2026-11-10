# Validation & readiness

[README](../../README.md) · [Getting started](../getting-started.md) · [CLI](cli.md) · [Profiles](profiles.md) · [Validation](validation.md) · [Operations](operations.md)

## How It Works

```
                    ┌───────────┐
                    │  ap run   │  You describe the task
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │  Daemon   │  Orchestrates everything
                    └─────┬─────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────▼─────┐ ┌──▼──┐ ┌─────▼─────┐
        │ Container  │ │ ... │ │ Container  │  Isolated pods per task
        │ (Agent)    │ │     │ │ (Agent)    │
        └─────┬─────┘ └──┬──┘ └─────┬─────┘
              │           │           │
        ┌─────▼─────┐    │     ┌─────▼─────┐
        │ Validate  │    │     │ Validate  │  Build → Test → Smoke → ACs → Review
        └─────┬─────┘    │     └─────┬─────┘
              │           │           │
        ┌─────▼─────┐    │     ┌─────▼─────┐
        │ AI Review │    │     │ AI Review │  "Does this match the task?"
        └─────┬─────┘    │     └─────┬─────┘
              │           │           │
              └───────────┼───────────┘
                          │
                    ┌─────▼─────┐
                    │  Notify   │  Screenshots + diff → Teams / CLI
                    └─────┬─────┘
                          │
                    ┌─────▼─────┐
                    │ ap approve│  One command to merge
                    └───────────┘
```

### Pod Lifecycle

Every task follows a state machine:

```
queued → provisioning → running → validating → validated → approved → merging → complete
                           │            │                                  ↓
                           │            └─→ failed (retry with feedback)  merge_pending
                           │                    │                              ↓
                           │                    └─→ review_required    fix pod spawned ←──────┐
                           │                           ├─→ running      (CI fail / review      │
                           │                           └─→ running       comments)             │
                           │                                             up to maxPrFixAttempts ┘
                           ├─→ paused (operator paused via ap pause / p key)
                           │      │
                           │      └─→ running (resumed via ap tell / nudge)
                           │
                           └─→ awaiting_input (agent escalated — needs help)

Any non-terminal state → killing → killed
```

**Fix pods** are spawned automatically when a pod's PR is blocked — by CI failures, failing checks, or `CHANGES_REQUESTED` review comments. The fix pod receives the original task plus sanitized failure summaries and reviewer notes, and pushes to the same branch. The cycle repeats up to `maxPrFixAttempts` (default: 3).

### Validation Pipeline

Validation is a multi-phase pipeline with two loops — each phase must pass before the next runs:

**Inner loop (agent self-validates):** While developing, the agent can use the `validate_in_browser` MCP tool to open a real browser in its container and verify work against acceptance criteria. This catches issues early, before the independent review.

**Outer loop (independent reviewer):**

| Phase | What happens | Configurable via |
|-------|-------------|------------------|
| **1. Setup** | Runs optional validation-time tooling setup before any checks | `profile.validationSetupCommand`, `profile.buildTimeout` |
| **2. Lint** | Runs optional static linting before build | `profile.lintCommand`, `profile.lintTimeout` |
| **3. SAST** | Runs optional security/static-analysis checks | `profile.sastCommand`, `profile.sastTimeout` |
| **4. Build** | Runs your build command inside the container | `profile.buildCommand`, `profile.buildTimeout` |
| **5. Test** | Runs your test suite (skipped if not configured) | `profile.testCommand`, `profile.testTimeout` |
| **6. Health check** | Starts the app and waits for HTTP 200 | `profile.startCommand`, `profile.healthPath` |
| **7. Smoke pages** | Playwright visits configured pages and checks assertions | `profile.smokePages` |
| **8. AC validation** | Classifies acceptance criteria as web/API/cmd/none and validates what can be executed | `pod.acceptanceCriteria` |
| **9. Required facts** | Runs contract-backed proof commands and checks declared artifacts | `pod.contract.requiredFacts` |
| **10. AI task review** | A separate model reviews the diff, task, contract, and prior findings | `profile.reviewerModel` |
| **11. Advisory browser QA** | Optional screenshot-backed AI browser pass that records evidence without changing validation outcome | `profile.pod.advisoryBrowserQaEnabled` |

Autopod computes the blocking validation decision from required phases. If any required phase fails, the agent gets structured feedback (setup output, console errors, build output, screenshot diffs, fact failures, AC failures, reviewer notes) and retries automatically. Advisory browser QA is stored as evidence for the operator and Readiness Review, not as a retry trigger. The AI reviewer receives tiered context: the diff, original task, contract, and findings from prior attempts.

**Worker versus control plane:** workers record the supplied checkout's actual
starting SHA, make scoped changes, run available checks, commit and report current
results through `report_task_summary`. Authenticated source refresh/provenance,
independent configured checks and authorized branch/PR publication belong to the
daemon. Missing container Git credentials alone do not prove stale source; actual
baseline mismatches or missing required evidence still need resolution. Workers
must not fetch/pull, change credentials/remotes or publish merely because task
prose says “fresh main” or “deliver a PR”. Artifact/none output grants no PR
publication authority.

Task review and pre-submit review are **pre-publication diff reviews**, not delivery
readiness verdicts. Their prompts prohibit treating pending daemon-owned
publication or unavailable container Git authentication as code defects, and
prohibit inventing requirements-check entries from operational task prose.
Explicit implementation requirements, dishonest evidence claims and actual code
defects remain reviewable. Historical summary blockers are not current validation
results; after recovery, update the structured summary with evidence rather than
only posting progress. None of this waives failed/pending validation, required
facts, source custody, approval or delivery guards. A review pass is not a claim
that a PR exists or that a freshness incident is resolved. Prompt changes do not
rewrite frozen submissions, repair stale stored summaries or reconcile existing
pods; those require their own supported recovery paths.

Packet-only pre-submit review collects the complete cumulative diff up to the
existing isolated input ceiling, separately from the 50,000-character desktop
and legacy preview limit. The final prompt must fit **1,000,000 UTF-8 bytes**,
including instructions, task, planned summary/deviations and appended admitted
reference context (including image evidence metadata). Nothing is silently trimmed
to fit. Truncation or an oversized packet produces an explicit incomplete-input
skip before paid inference, fresh-review budget reservation or passing-cache reuse.
Reported file/line counts describe the collected diff; a skipped partial packet
does not certify omitted files. Isolated reviewers still receive no worker
workspace, source credentials or coding authority.

Acceptance diffs include changed **lockfile hunks**, not entire lockfiles. This
also applies to minified source assets: the display preview's noise filter is not
review authority. Only daemon-injected code-intelligence caches are omitted by
this review policy. Host validation, revalidation and live-container pre-submit
review use the same policy, including the host fallback; lockfile-only changes
remain real changes for safety admission. Display previews retain their own
filters and size limits. A large rewrite still counts toward the existing input
ceiling and cannot earn a passing review when truncated.

Pre-submit receipts bind both diff scope/source identity and the final prepared
packet hash. Changed source, task context, summary/deviations or references require
fresh review; unchanged complete packets can reuse a passing receipt. Older
receipts without packet identity cannot bypass this admission. Legacy tool runners
and preview caps remain available; a truncated pre-submit packet cannot earn a pass.
Source changes only affect a daemon running the new collector. They do not patch
the deployed review service, rewrite earlier partial receipts, or waive configured
independent review. Preserve an incomplete deployed review result honestly until
the deployment owner installs and verifies the new collector.

### Full repository validation capacity

The repository's root `npx pnpm test` keeps package jobs serial. Declaration builds
and real-process CLI fixtures must not contend across Turbo packages while each
package's own bounded test workers run. The CLI suite, like the daemon suite,
uses two workers. This changes scheduling, not test inventories, assertions or
individual deadlines. Preserve the full command's measured outer runtime when
qualifying a worker: a frozen fifteen-minute limit is not adequate merely because
focused checks passed. For an existing eligible Docker retained continuation,
the separately authorized finite outer-test allowance is documented in
[retained continuation](../retained-pod-continuation.md#one-finite-docker-outer-test-allowance).
Changing source/defaults never rewrites a frozen launch or grants retry permission.

Every validation attempt is stored with full results and **proof-of-work screenshots** — one per smoke page, AC browser check, and review screenshot. Screenshots are served from authenticated URLs like `GET /pods/:id/screenshots/:source/:filename`. Contract fact evidence is also exportable as `GET /pods/:id/validations/:attempt/evidence.yaml`.

After validation, the container is **stopped** (not removed). Launch an on-demand **preview** to interact with the agent's work in a real browser before approving.

Before approval, Autopod computes a compact **Readiness Review** snapshot from validation, security, action audit, network denials, advisory QA, scope, quality, and PR state. Automation only approves `ready` pods. Manual approval can proceed through `needs_review`; `risky` and `waived` approvals require a reason (`ap approve <id> --reason "..."`).

**When retries are exhausted** (`maxValidationAttempts` reached), the pod moves to `review_required` instead of just failing. From there you can:

- Grant more validation attempts from the desktop/API so the agent retries with accumulated feedback.
- Create a linked manual-fix workspace from the desktop/API, then re-validate.
- Reject from the CLI with `ap reject <id> "<feedback>"` to restart with your notes.

**Operator overrides:**

The daemon also supports interrupting in-flight validation and queueing per-finding validation overrides (`dismiss` or `guidance`) through the desktop/API. Overrides are persisted as auditable human decisions and merged into the next review pass.

---
