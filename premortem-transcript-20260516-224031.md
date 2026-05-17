# Premortem Transcript — ACs to Durable Facts

Generated: 2026-05-16 22:40:31 Europe/Copenhagen

## Context

Autopod is considering changing its pod/spec workflow from acceptance criteria as temporary pod gates toward a facts-first model.

Current context from the repo:

- Briefs and `/plan-feature` / `/prep` already use structured `acceptance_criteria` frontmatter with `api | web | cmd` checks.
- Brief bodies already include `## Test expectations` as the main anchor for normal package tests.
- `specs/ac-schema-v2` recently tightened ACs into `outcome`, `hint`, and `polarity` so the validation engine can run observable checks.
- The repo already has early language around `docs/facts` in the planner skill, but this is not yet a complete merge-enforced system.

Desired success:

Every behavioral AC either maps to a durable fact, such as a unit test, integration test, API contract test, property/invariant test, smoke test, or CI command, or is explicitly marked human-review-only.

Stakeholders:

- The human owner of Autopod.
- Agents and pods consuming briefs.
- The daemon validation engine.
- CLI and desktop users.
- Future maintainers.

## Premortem Frame

It is 6 months from now. Autopod tried to move from AC-only pod gates to durable executable facts as repo memory, and the effort failed. We are looking backward to understand why.

## Raw Failure Reasons

1. The team renamed ACs into facts rhetorically, but did not create a hard merge gate that requires durable tests or invariants to land with code. The old AC problem survived under new terminology.
2. The model overcorrected from vague ACs to verbose Given/When/Then and facts paperwork, making briefs heavier while not improving the actual tests. Pod throughput dropped and humans stopped maintaining the new sections.
3. The validation engine can run `api`, `web`, and `cmd` AC checks, but most important repo truths live below those surfaces. The plan failed because it treated executable facts as mostly external validation probes instead of requiring normal co-located tests in the packages that own the behavior.
4. Agents produced low-quality facts: brittle snapshots, superficial smoke checks, or tests that asserted implementation details. CI went green, but the facts did not protect the original behavior and created false confidence.
5. The facts model broke down at the boundaries: desktop UX, subjective quality, external integrations, and operational workflows were hard to express as durable tests, so the system either labeled too much human-review-only or forced awkward fake checks.
6. The schema and tooling became split-brained: briefs, desktop forms, issue watcher parsing, CLI `--ac-from`, validation engine, and skills adopted slightly different meanings for AC, scenario, fact, and test expectation. Agents followed whichever version they saw last.

## Deep Dives

### 1. Renamed ACs Without a Merge Gate

Six months later, “facts-first” exists mostly as vocabulary. Briefs now say “durable facts” instead of “acceptance criteria,” and pods dutifully write frontmatter that classifies checks as test, invariant, CI command, or human-review-only. But merge review still accepts PRs where those mappings are aspirational: a fact is mentioned in the spec, maybe echoed in the PR body, and then disappears once the branch lands.

The validation engine improved at reading observable checks, but nobody made “every behavioral AC must land as code or an explicit human-review exception” a blocking rule. Maintainers kept merging because the feature worked manually, the pod had green local tests, or the human owner understood the intent. The system slowly rebuilt the old failure mode: beautiful pre-merge intent, weak post-merge memory.

By month six, future pods trust repo “facts” less because they cannot tell which ones are enforced, stale, or merely historical claims. CLI and desktop users see regressions that should have been caught by contract/API/smoke tests. The terminology changed, but the repo still has no durable behavioral ledger.

Underlying assumption: The plan assumed that renaming and structuring ACs would change merge behavior without requiring an enforceable merge gate.

Early warning signs:

- PRs include “fact mappings” in prose, but no corresponding test, invariant file, CI command, or explicit `human-review-only` marker changes.
- Review comments ask whether a behavior is “captured somewhere,” but merges proceed after verbal confirmation instead of a failing check or required artifact.

### 2. Ceremony Without Better Tests

Six months later, the facts-first workflow technically exists, but briefs have become slower to write and harder to consume. Every AC now blooms into Given/When/Then prose, “durable fact” mapping, review-only tags, and validation notes. Pods spend more context parsing the ceremony than understanding the change. Humans start copy-pasting old sections forward because the cost of being precise feels higher than the value.

The worst part is that the extra structure does not meaningfully improve tests. Many mapped “facts” are weak smoke commands, stale invariants, or aspirational notes that never make it into CI. The validation engine still runs roughly the same checks, but now everyone feels like they did more work. The system gained compliance language, not better behavioral memory.

Eventually maintainers stop treating the new sections as source of truth. Brief authors mark ambiguous items as human-review-only to avoid paperwork. Reviewers skim the fact mappings. Future pods inherit verbose specs that look rigorous but do not reliably tell them what must remain true.

Underlying assumption: The plan assumed that making ACs more explicit would naturally convert ambiguity into durable tests, instead of creating a documentation burden unless the conversion path was cheap and enforced.

Early warning signs:

- Median brief size and prep time increase by 30% or more, while the number of new or strengthened tests per pod stays flat.
- More than 20% of behavioral ACs are marked human-review-only, duplicated from prior briefs, or mapped to generic commands like “run tests” without a specific asserted behavior.

### 3. Facts Live Too Far From the Code

Six months later, Autopod technically has “facts-first” specs, but the facts mostly live as `api`, `web`, and `cmd` probes attached to briefs or validation runs. They catch whether the system appears to work from the outside, but they do not encode the lower-level invariants that actually keep the repo sane: state-machine legality, migration behavior, repository persistence semantics, profile inheritance, stream parser edge cases, PR fix-pod retry rules, and validation result parsing.

Pods start optimizing for satisfying external probes instead of strengthening the package that owns the behavior. A daemon change passes an API AC because the happy-path endpoint responds correctly, while the co-located repository or state-machine tests never get updated. Later, another pod refactors internals and unknowingly breaks the hidden contract. The validation engine still has green probes, but maintainers lose confidence because the durable repo memory is shallow and positioned too far from the code.

Eventually, “facts” become a second validation layer instead of a replacement for forgotten acceptance criteria. They are useful smoke tests, but not durable ownership artifacts. The important truths remain tribal knowledge unless a human notices and asks for a unit, integration, contract, or property test in the owning package.

Underlying assumption: The plan assumed executable facts could mostly be represented as external observable checks, rather than requiring behavior-owned tests and invariants co-located with the package that defines the truth.

Early warning signs:

- Specs regularly produce new `api`, `web`, or `cmd` ACs but few or no changes to co-located `*.test.ts` files in `packages/shared`, `packages/daemon`, `packages/validator`, or `packages/cli`.
- Review comments start saying “this passes validation but should have a real test,” especially around state transitions, migrations, parsers, profile validation, and persistence behavior.

### 4. Low-Quality Facts Create False Memory

Six months later, the facts-first workflow technically shipped, but agents learned to satisfy the shape of “durable fact” without preserving behavior. Briefs that once had readable ACs became PRs full of brittle snapshots, happy-path smoke tests, and assertions against private helper names or DOM structure. The validation engine saw executable checks. CI went green. Maintainers assumed the behavior was now protected.

The failure became visible during refactors. A pod changed user-facing behavior while keeping the superficial smoke test passing. Another broke an API edge case because the generated “fact” asserted the current response fixture, not the contract behind it. Worse, reviewers stopped interrogating AC quality because “every AC maps to a fact” sounded like coverage. The system preserved artifacts, but not intent.

The repo accumulated false memory: tests that resisted harmless implementation changes while missing real regressions. Future pods treated these facts as authoritative, copied their style, and amplified the problem.

Underlying assumption: The plan assumed agents could reliably translate behavioral acceptance criteria into meaningful, intent-preserving tests without strong quality gates or review heuristics.

Early warning signs:

- New facts frequently assert snapshots, CSS/DOM structure, mock call order, or exact fixture blobs instead of observable contracts, invariants, or user-visible outcomes.
- Review comments shift from “does this protect the behavior?” to “does this AC have a test attached?”, and generated tests rarely fail when intentionally seeded regressions are introduced.

### 5. Boundaries Resist Simple Fact Conversion

Six months in, the facts-first model looked solid for API behavior and CLI flows, but frayed anywhere the product depended on judgment, environment, or cross-system state. Desktop UX changes produced facts like “button exists” or “view renders,” while the actual failures were about discoverability, confusing state transitions, notification timing, and whether a human could safely operate the workflow. The facts became technically durable but semantically thin.

External integrations were worse. GitHub, Azure, Teams, Docker, auth, and desktop OS behaviors did not fit cleanly into stable repo-local checks. Teams either marked these as human-review-only, which made the new model feel optional, or invented brittle fake checks that passed in mocks while production behavior drifted. Over time, pods learned to satisfy the shape of facts without preserving the intent behind them.

Operational workflows became the quiet casualty: “operator can recover a stuck pod,” “desktop makes merge-pending understandable,” “review comments spawn the right fix pod,” and “credential escalation feels safe” were too contextual for simple AC-to-test conversion. The repository accumulated durable artifacts, but the most important boundary behaviors remained in human heads.

Underlying assumption: The plan assumed most meaningful behavioral acceptance criteria could be translated into durable, repo-owned facts without losing the judgment, context, or environment that made them meaningful.

Early warning signs:

- More than 25-30% of new behavioral ACs are marked `human-review-only`, especially in desktop, integrations, auth, notifications, and ops workflows.
- Reviews repeatedly reject generated “facts” as fake confidence: mock-heavy checks, screenshot existence tests, or command checks that prove plumbing but not the real user or operator outcome.

### 6. Split-Brained Schema and Tooling

Six months later, “AC” no longer means one thing. Briefs use `acceptance_criteria` as observable outcomes. Desktop forms call them scenarios. The issue watcher parses checklist text as test expectations. CLI `--ac-from` imports older phrasing. The validation engine expects polarity and hints. Skills tell agents to convert behavioral ACs into durable facts, but each skill names and groups them differently.

The breakage was gradual. One pod marked a scenario as human-review-only because it had no runnable check. Another converted the same kind of item into a fact. A third wrote a smoke test but left the brief AC unchanged. Reviewers started seeing PRs where “all ACs passed” meant the validation engine passed, while maintainers meant “facts were preserved after merge.” Everyone was technically following instructions, just not the same instructions.

Eventually agents learned to optimize for whichever representation was closest: the brief, the desktop UI, the issue body, or the schema docs. The repo gained more ceremony but less shared truth. Ambiguity moved from natural language into competing structured fields.

Underlying assumption: The plan assumed that introducing better terms would naturally converge the ecosystem, instead of requiring one canonical contract enforced at every ingestion and authoring boundary.

Early warning signs:

- The same behavioral requirement appears as an AC in one generated brief, a scenario in another, and a fact/test expectation elsewhere with no lossless round-trip.
- Validation passes while merged PRs contain no durable artifact for one or more non-human-review behavioral ACs.

## Synthesis

### The Most Likely Failure

The most likely failure is semantic drift into ceremony: new sections get added to briefs, but no enforceable rule ensures a durable artifact lands with the code. This is likely because Autopod already has several AC-related surfaces, and adding “facts” as another surface is easier than changing merge behavior.

### The Most Dangerous Failure

The most dangerous failure is low-quality facts creating false confidence. A bad test is worse than no test when future pods treat it as authoritative repo memory. It can preserve implementation details while missing the behavior the original AC cared about.

### The Hidden Assumption

The hidden assumption is that “executable” automatically means “durable truth.” It does not. A fact is only durable if it is enforced in CI, owned near the behavior, and reviewed for whether it protects intent rather than syntax.

### Revised Plan

1. Define one canonical contract:
   - `acceptance_criteria` are pre-merge observable validation probes.
   - `test_expectations` describe package-owned tests expected from the pod.
   - `durable_facts` are merge-enforced artifacts that remain after merge.
   - `human_review_only` is an explicit exception with a reason.

2. Do not require Given/When/Then everywhere. Use it only for multi-step behavior, state machines, user workflows, or ambiguous domain rules. Keep simple invariants as short fact statements.

3. Make the merge rule narrow and enforceable: every behavioral AC must map to either a changed durable artifact or a `human_review_only` exception.

4. Prefer behavior-owned facts over external probes:
   - State-machine behavior belongs in state-machine tests.
   - Parser behavior belongs in parser tests.
   - API contracts belong in route/integration tests.
   - CLI behavior belongs in CLI tests or command smoke checks.
   - Desktop judgment gets snapshot-free view model tests plus human-review markers where judgment remains subjective.

5. Add a fact-quality checklist to review:
   - Would this test fail if the original AC were violated?
   - Does it assert user-visible behavior, public contract, or invariant rather than private structure?
   - Is it co-located with the code that owns the behavior?
   - Is it stable under harmless refactors?

6. Pilot the model on one narrow lane first: daemon behavior briefs. Do not roll it across desktop, integrations, and operational workflows until the package-owned path is cheap.

### Pre-Launch Checklist

- Pick a single canonical vocabulary and update `/prep`, `/plan-feature`, CLI/issue watcher parsing, desktop labels, and validation docs together.
- Add a lightweight PR/final-summary requirement: list each behavioral AC and its durable artifact path, or mark it `human_review_only` with a reason.
- Add reviewer guidance that rejects generic `run tests`, snapshots, fixture-only assertions, and private-structure tests as durable facts.
- Measure for 10 pods: brief size, prep time, number of strengthened tests, number of human-review-only exceptions, and number of reviewer rejections for weak facts.
- Start with daemon/package tests before expanding to desktop and external integrations.
