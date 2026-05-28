# Premortem — Context-Atoms Design

**Date**: 2026-05-28
**Framing**: Imagine it is 6 months from launch. The project has failed. Working backward to identify why.
**Method**: Following the premortem skill (5 phases) — raw failure generation → parallel deep-dives → synthesis.

---

## Phase 1 — What's being premortemd

A context-persistence system for AI coding agents, replacing heavy SDD-style specs with atomic, anchored, kind-typed memory.

**Storage**: Repo-local atomic markdown files in `docs/context/{intent,decisions,constraints}/`. One fact per file, 30–80 lines max, YAML frontmatter declaring `kind`, `anchors` (code globs), `tags`, `links` (refines / supersedes / contradicts / implements / related), `status`. Files committed to git, reviewed in PRs.

**Retrieval**: Interview skill produces a structured envelope `{files, subsystems, tags, flows}`. A pure-function selector then: (1) anchor∩envelope.files, (2) tag∩envelope.tags, (3) one-hop graph walk over links, (4) dedupe and order by kind (intent → decision → constraint). Agent has escape-hatch `context.search`/`context.walk` tools.

**Lifecycle**: Post-task "distill" step proposes atoms; PR-touched-anchors checklist gates curation; churn-based staleness (commits to anchored files since atom last edited).

**Verification**: lint, selector unit tests, golden regressions, telemetry (gap rate, noise rate), ablation eval.

**Packaging**: standalone CLI + MCP server, tool-neutral, usable across repos without depending on autopod.

**Key prior evidence**: The ETH Zurich + LogicStar.ai AGENTS.md study (arXiv 2602.11988) found that flat repo-level context files reduced task success in 5/8 settings and added 20%+ cost. The design **bets** that *selective, scoped* injection behaves fundamentally differently — this is unverified.

**Success criteria for "shipped"**:
- ≥3 repos adopt the standalone tool.
- Selector gap-rate <10% after 60 days.
- Atom-using pods outperform no-atom baseline by ≥3% on task success.

---

## Phase 2 — Raw failure modes (1–2 sentences each)

1. **Empirical disproof.** Atoms hurt agent success rate even when atomic and scoped; the AGENTS.md study's finding generalizes regardless of selectivity.
2. **Curation collapse.** Atom authoring drops to near-zero after initial enthusiasm; "review affected atoms" PR checkbox becomes rubber-stamped.
3. **Wiki-ification.** Atoms grow verbose despite size lints; content discipline erodes; we ship specs in a different directory.
4. **Kind collapse.** `intent` / `decision` / `constraint` blur in practice; people write all three the same way; kind-ordering becomes meaningless.
5. **Anchor rot.** Refactors break anchors silently and faster than they're fixed; orphan rate climbs; retrieval trust erodes.
6. **Envelope weakness.** Fuzzy-to-structured conversion is unreliable; LLM extraction mislabels; selector fires on bad inputs.
7. **Selector calibration.** One-hop is wrong-sized and there's no clean tuning regime; the selector becomes a knob factory.
8. **Too-late paradox.** Atoms are captured *after* the work but the agent needed them *before*; corpus becomes an archaeology of agent improvisation.
9. **Non-autopod adoption fails.** CLI ergonomics feel autopod-shaped; tool-neutrality benefit never materializes.
10. **Distill quality.** Agent-proposed candidates are wrong / redundant / trivial; humans waste time rejecting; loop disabled.
11. **Maintainer bus factor.** Standalone repo dies — one maintainer, no contributors, abandoned in 8 months.
12. **Schema versioning.** Repos at mixed schema versions; migration is painful; users stick on v1 forever.
13. **Privacy boundary.** Atoms leak strategic / customer-specific decisions into a shared repo; enterprise security blocks adoption.
14. **Atoms-are-too-late, agent edition.** Atoms describe the *as-built* world; the agent reads them and replicates yesterday's design instead of producing today's.
15. **Selection blind spot.** No fallback when envelope misses the actual subsystem in play; agent gets a confidently-wrong context.

The first 8 received parallel deep-dives in Phase 3. The remaining (9–15) are flagged as operational/secondary risks and addressed in Phase 4 mitigations rather than individually deep-dived.

---

## Phase 3 — Deep-dives

### 3.1 Empirical disproof

#### Failure narrative

**Month 0-2:** Ship v1 with selector + 40 curated atoms in autopod repo. Distill step generates ~6 atoms/PR. Subjective dev feedback positive: "agents quote my decisions back to me."

**Month 3:** First ablation eval (50 tasks, atoms-on vs atoms-off) shows atoms-on at 72% success vs atoms-off at 74%, token cost +18%. Within noise. Team attributes to selector tuning; tightens anchor globs, halves average injection from 4 atoms to 2.

**Month 4-5:** Atom library grows to ~180 files across 3 dogfooding repos. Re-run ablation, n=200: atoms-on 68%, atoms-off 75%. Token cost +24%. Statistically significant (p<0.01). Breakdown: simple tasks (rename, bugfix) regress hardest (-9pp); novel-architecture tasks roughly flat.

**Month 6:** Telemetry shows agents that receive even one constraint atom open 2.3× more files in first 5 tool calls than control. Atoms are not being *used* — they're priming exploration. Selector precision is 81% (high), but precision isn't the lever. The act of injection itself widens the agent's search frontier. ETH Zurich result reproduced under scoped injection. Design's core bet falsified.

#### Underlying assumptions that proved false

- **Scoping changes the agent's response to injected context.** It doesn't — agents treat any frontmatter-flagged "constraint" as a signal that the problem is bigger than it looks, regardless of token count.
- **Precision is the right optimization target.** Selector precision was high; the failure was that *receiving curated context at all* triggers broader exploration behavior.
- **Atoms compose neutrally with the task prompt.** They don't — they shift the agent's prior over which files matter, even when anchors are tight.
- **Token cost scales with atoms injected.** It scales with *exploration triggered by* atoms, which is ~5× the direct injection cost.
- **Dogfooding signal would catch regressions.** Devs liked the feature subjectively while it was making agents worse — perceived quality and measured success diverged.

#### Early warning signs

- Ablation eval delta crosses -2pp on any task category by month 3 (caught at month 5 here — should have been a hard gate).
- "Files opened in first 5 tool calls" ratio (atoms-on / atoms-off) exceeds 1.5× — direct measure of exploration bias.
- Token cost overhead exceeds 15% on simple tasks (rename/typo/bugfix) where atoms should be near-zero help.
- Gap rate (agent asks for info that exists in an atom) stays flat or rises despite library growth — atoms aren't being read, just reacted to.
- Subjective dev satisfaction rising while measured success rate flat or declining — divergence signal.

#### Mitigations the design could adopt

- **Gate launch on ablation eval, not lint/golden tests.** Require +3pp success delta on a frozen benchmark before any user sees injected atoms. Re-gate quarterly.
- **Make injection opt-in per task class.** Default off for simple tasks; only inject for novel/architectural work where the AGENTS.md study showed neutral-to-positive effects.
- **Inject by reference, not content.** Surface atoms as `context.search` results the agent must explicitly fetch — converts "priming" into "pull," matching the study's finding that pulled context behaves differently from pushed.
- **Ship telemetry before content.** Land the push/pull/gap-rate/exploration-ratio metrics in week 1, with atoms behind a flag, so the team can't ship blind for 5 months.

---

### 3.2 Curation collapse

#### Failure narrative

Week 1: an enthusiastic staff engineer seeds 22 atoms over a weekend. Week 2-3: three teammates add another 8, mostly decisions ("we chose Fastify because..."). The selector works — agents quote atoms in PRs, which feels magical. Week 4: the first "review affected atoms" checkbox appears on a PR touching `pods/state-machine.ts`. The author skims, sees the atom still reads plausibly, checks the box. Week 6: a refactor renames `processPod` to `runPodLoop`. The anchor glob still matches the file, so the atom isn't flagged. Nobody notices the atom now describes a function that doesn't exist. Week 10: the original seeder goes on parental leave. Week 12: someone asks "is this atom still right?" in PR review; nobody knows; the PR ships anyway. Month 4: an agent confidently cites a superseded atom about the old SQLite schema, producing a wrong migration. The team blames "the AI" rather than the stale corpus. Month 5: the distill step still proposes atoms, but PRs reject them as "we'll do it later." Month 6: the `docs/context/` directory is treated as legacy documentation. The selector still returns results — they're just wrong.

#### Underlying assumptions that proved false

- That engineers will edit markdown files at PR time as a *new habit* rather than a chore competing with shipping.
- That "well-formed" (lint-passing) correlates with "accurate." It doesn't — staleness is invisible to syntax.
- That churn-based staleness detection catches drift. Anchored files churn constantly for unrelated reasons; the signal is too noisy to act on, so it gets ignored.
- That the distill step's *proposals* will become *merges*. Proposing is cheap; reviewing and merging atoms is the actual bottleneck.
- That a single seeder's enthusiasm generalizes to the team. Curation has a long tail of unrewarded work.

#### Early warning signs

- Atom creation rate drops >60% sprint-over-sprint after sprint 1 (e.g., 30 → <12).
- "Review affected atoms" checkbox check-time median <3 seconds (telemetry on the GitHub check).
- Distill-proposed atoms have <20% merge rate after 2 weeks.
- Gap rate (agent escape-hatch invocations) trending up while corpus size flat — agents are routing around stale atoms.
- Atom-to-anchored-file ratio shrinking: anchored files growing 5× faster than atoms covering them.

#### Mitigations the design could adopt

- **Make staleness loud, not silent.** When an anchored file's AST symbols (not just churn) change, mark the atom `suspect` and surface it in PR comments with the specific diff that triggered it. Block merge until acknowledged.
- **Shift curation left, into the agent.** Have the agent itself propose atom edits as part of its diff — the human reviews *code + atom delta* together, not atoms separately. Curation rides on the existing PR-review habit.
- **Decay atoms automatically.** Atoms unverified for N weeks demote to `archived` and stop appearing in selector output. Force re-verification rather than tolerating silent rot.
- **Measure outcome, not output.** Replace atom-count dashboards with gap-rate and agent-citation-accuracy (sampled human grading). If the corpus isn't helping agents, kill it loudly rather than letting it fade.

---

### 3.3 Wiki-ification

#### Failure narrative

**Month 1:** Authors write tight atoms — 20-40 lines, one fact each. The lint cap of 80 lines feels generous. Code review catches the occasional sprawl.

**Month 2:** First "compound" atom appears. A decision atom about auth also captures three related constraints because "they're conceptually inseparable." Reviewer approves — it's under 80 lines and well-written. Precedent set.

**Month 3:** Atoms acquire H2 headers: `## Context`, `## Decision`, `## Tradeoffs`, `## Open Questions`. Each section is short, but the file now bundles four sub-facts. Median atom length climbs from 32 to 51 lines.

**Month 4:** Authors discover that one fat atom retrieves better than three thin ones (the selector returns it for more envelope queries). Incentive flips: longer atoms win more agent context slots. New atoms target ~70 lines.

**Month 5:** A new contributor reads existing atoms as templates and writes their first one at 78 lines with nested bullet lists three levels deep. No lint complaint.

**Month 6:** Agent receives the envelope, selector returns 5 atoms (well under any count limit), but they total 400 lines of dense mixed prose with overlapping concerns. Performance degrades exactly like the AGENTS.md monolith the system was built to replace.

#### Underlying assumptions that proved false

- **Authoring discipline is durable under social pressure.** Reviewers won't reject an atom that's "a bit long but really well-written" — especially from a senior contributor.
- **File-size cap is a proxy for content shape.** 80 lines of one idea ≠ 80 lines of four ideas; the lint can't tell.
- **Atomicity is self-reinforcing.** It isn't — fat atoms outcompete thin ones in retrieval, creating an incentive gradient toward bloat.
- **"One fact per file" is unambiguous.** In practice "fact" is interpretation-dependent and drifts toward "topic."
- **PR review will catch drift.** Reviewers optimize for correctness of the content, not for atomic shape; shape erosion is invisible at the diff level.

#### Early warning signs

- **Median atom length crosses 50 lines** (vs. baseline target of 30-40). Track p50 and p90 weekly.
- **Heading count per atom rises above 1.** An atom with H2/H3 subsections is almost always multi-fact.
- **Mean atoms-per-envelope drops while mean tokens-per-envelope rises** — selector returning fewer, fatter results.
- **Frontmatter `kind` distribution narrows** — fewer pure `constraint` atoms, more `decision` atoms acting as catch-alls.
- **Link graph density falls** — fat atoms absorb what would have been separate linked atoms, so cross-links decrease.

#### Mitigations the design could adopt

- **Lint on shape, not just size:** reject atoms with more than one H2, more than N bullet points at top level, or more than one frontmatter `kind`. Cap at ~40 lines, not 80.
- **Semantic single-claim check:** require a `claim:` field in frontmatter (one sentence). CI runs an LLM check that the body supports exactly that claim — fail if it covers more.
- **Retrieval anti-incentive:** selector penalizes atom length (token-normalized relevance), so fat atoms lose ranking. Removes the gradient toward bloat.
- **Periodic corpus audit job:** weekly report of p50/p90 length, heading counts, and a "drift score"; surface top 10 atoms most likely to need splitting, with a one-command `atom split` workflow.

---

### 3.4 Kind collapse

#### Failure narrative

Month 1: clean. An `intent` atom says "Pod tokens exist because containers need short-lived credentials without long-lived PATs." A `decision` says "We chose HMAC over JWT because no key rotation infra." A `constraint` says "Pod tokens must be <2KB to fit in container env vars."

Month 3: drift starts. Someone writes `intent/network-isolation.md`: "Containers need network isolation because untrusted agent code runs inside them. We chose iptables over Docker network policies because iptables works inside the existing bridge network." That's intent + decision fused. A reviewer flags it; author splits it; the split atoms now both reference each other and feel redundant.

Month 6: collapse. `constraint/migration-numbering.md` opens with three paragraphs explaining *why* migrations are numbered (intent) before stating the rule. `decision/sqlite-over-postgres.md` ends with "and therefore: never assume concurrent writers" (a constraint). New contributors copy whichever neighbor file they opened first. A `kind:` field becomes a coin flip. PR reviews argue about kind assignment for atoms whose content everyone agrees on. The selector orders intent→decision→constraint, but since `intent/foo.md` actually contains a decision and `decision/bar.md` actually contains intent, the ordering injects "why" *after* "what" half the time. Agents get scrambled context; no one notices because outputs still look plausible.

#### Underlying assumptions that proved false

- That "why exists" / "why chose" / "what must hold" are cleanly separable in real engineering prose — in practice every decision has embedded intent, every constraint has a rationale.
- That authors will reach for the right kind without a forcing function beyond a directory name.
- That borderline atoms are rare; in fact most non-trivial atoms span two kinds.
- That review will catch mis-kinding — but reviewers themselves disagree on kind, so review converges on "looks fine."
- That selector ordering is robust to ~10% mis-kinding; in fact even 30% mis-kinding silently corrupts the intent→decision→constraint narrative the agent reads.

#### Early warning signs

- Kind-change rate in PR review >15% (atoms switching kind between draft and merge).
- Inter-rater disagreement test: give 5 engineers 10 existing atoms with kind stripped; if agreement <70%, the taxonomy is folk-knowledge.
- Atoms containing "because" in `constraint/` or "must" in `intent/` — keyword leak as a cheap proxy.
- PR comments arguing about kind assignment without arguing about content.
- New-contributor first atoms cluster heavily in one kind (usually `decision/`) — signals they're guessing the safe default.
- Atom length variance collapses across kinds — intent atoms should be shorter than decisions; if not, they're decision-shaped.

#### Mitigations the design could adopt

- **Structural templates per kind** — `intent/` files must have only a "Why this exists" section and no "We chose"; `decision/` must have "Options considered" and "Chosen because"; `constraint/` must lead with an imperative ("MUST", "NEVER"). Linter rejects atoms missing the required section.
- **Collapse to two kinds**: `rationale` (why, including chosen-because) and `constraint` (invariants). Intent-vs-decision is the blurry boundary; constraint-vs-everything-else is sharp.
- **Promote ordering signal out of kind**: add an explicit `depends_on:` field so selector ordering follows declared dependencies, not taxonomy. Kind becomes advisory, not load-bearing.
- **Inter-rater calibration in CI**: a periodic job samples N atoms, strips kind, asks an LLM to re-classify; flag drift when reclassification disagreement crosses a threshold.

---

### 3.5 Anchor rot

#### Failure narrative

The first month is clean: atoms ship with precise anchors like `packages/daemon/src/pods/pod-manager.ts` and the checklist fires reliably. Month two, someone splits `pod-manager.ts` into `pod-orchestrator.ts` + `pod-lifecycle.ts`. The atom's anchor still resolves (the file exists from a stale rebase) until it doesn't — lint goes red on an unrelated PR touching `pods/`. The author has no context on the atom, can't tell if the anchor should point at one new file or both, and adds `// lint-disable anchor-resolve` to unblock CI. Three sprints later, the daemon directory reorg moves 40 files; 60 atoms break at once. Nobody owns the backlog. Someone "fixes" it by rewriting specific anchors to `packages/daemon/src/pods/**`, which silences the lint but now every pod touching pods/ surfaces six atoms, four irrelevant. Reviewers see the "review affected atoms" checklist fire on a typo fix, dismiss it, and the muscle memory sticks. By month six the checklist is decorative — retrieval still works for atoms whose anchors happen to be current, but no one trusts which ones those are.

#### Underlying assumptions that proved false

- Refactor authors will update anchors as part of the refactor (they don't — anchors are someone else's atom, written for someone else's pod).
- Lint warnings on orphans create enough pressure to fix them (warnings accumulate; the first PR blocked by an unrelated orphan teaches everyone to disable).
- Glob anchors are a reasonable fallback for unstable paths (they are, but they collapse the signal-to-noise of the checklist, which is what made retrieval trustworthy).
- Anchor correctness degrades gradually (it doesn't — directory reorgs and file splits invalidate dozens at once, faster than ambient maintenance).
- The PR checklist is robust to a partially-wrong anchor set (it isn't — once ~20% of fired atoms are irrelevant, reviewers stop reading any of them).

#### Early warning signs

- Orphan rate >5% of total atoms, or growing >2pp/month.
- Lint-disable-comments referencing anchor rules appearing in >1 PR/week.
- Ratio of `git mv`/rename commits to anchor-updating commits drifts above ~10:1.
- Glob-anchor share of total anchors climbs past ~30% (sign of "make the lint shut up" rewrites).
- Checklist dismissal rate: PRs where reviewers tick "reviewed affected atoms" in <5 seconds, or skip it entirely, trending up.
- Atom-touch-followed-by-revert: atoms updated then reverted within a week (sign of wrong anchor pointing at unrelated edits).

#### Mitigations the design could adopt

- Git hook (`post-commit` or pre-push) that detects renames via `git log --follow --name-status -M` and auto-rewrites matching anchors, opening a one-line PR or amending in place.
- **Symbol-based anchors via tree-sitter**: `anchor: pods/pod-manager.ts#processPod` resolves to the function regardless of which file it lives in; survives splits and moves.
- Anchor freshness signal in the atom header (last-verified commit SHA); selector deprioritizes atoms whose anchors haven't resolved cleanly in N commits, and the checklist tags them "stale — verify before trusting."
- Block the lint-disable escape hatch: orphans become CI errors after a grace window (e.g., 7 days from first detection), forcing fix or atom deletion rather than indefinite accumulation.

---

### 3.6 Envelope weakness

#### Failure narrative

Week 1-4: envelopes look fine. The interview skill produces clean YAML because humans are paying attention to a new tool. Mechanical `files` derivation is rock-solid. LLM extraction on prose looks reasonable in spot checks.

Week 5-12: drift sets in. Devs notice the interview's envelope-confirmation step is the slowest part of `/prep` and start mashing "looks good" without reading. The LLM extractor, given longer briefs, starts inventing `flows` ("user-auth-flow", "payment-flow") that don't exist as canonical tags — but the validator only checks shape, not membership. `subsystems` get plausible-but-wrong labels: a change to `pod-manager.ts` gets tagged `orchestration` when the canonical taxonomy uses `pod-lifecycle`. The taxonomy itself drifts as new subsystems are added without backfilling old envelopes.

Week 13-26: the selector retrieves atoms tagged `orchestration` for a query about `pod-lifecycle` and misses everything relevant. Agents see injected context that's tangentially related to their task and learn — correctly — that it's noise. They start every task with grep/read tool calls. The push channel becomes decorative. Someone proposes "just let the agent retrieve" and the architecture's premise quietly dies.

#### Underlying assumptions that proved false

- That a canonical taxonomy for `subsystems`/`tags` would stay stable enough that envelopes authored months apart remain comparable. In practice the taxonomy drifts faster than envelopes get re-labeled.
- That LLM extraction with a schema validator catches semantic errors. Schema validates *shape* (string, enum-member), not *correctness* (right subsystem for these files).
- That humans will meaningfully review an LLM-proposed envelope during interview. They rubber-stamp it once the novelty wears off.
- That `flows` is a learnable category. It's actually a fuzzy human concept ("the checkout journey") that different authors carve up differently — there's no ground truth to extract against.
- That mechanical `files` coverage compensates for weak `subsystems`/`tags`. The selector weights tags heavily; bad tags poison good files.

#### Early warning signs

- Envelope-field-correction rate during interview drops below ~15% after week 4 (humans stop correcting → either perfect extraction or rubber-stamping; bet on the latter).
- LLM-extractor F1 by field, measured against a held-out human-labeled set: `files` >0.95, `subsystems` <0.75, `flows` <0.5, `tags` declining month-over-month as taxonomy grows.
- Selector precision@5 trending down even as the atom corpus grows.
- Manual override rate on injected context climbing — agents emitting "ignore the above context" or immediately tool-calling for the same info.
- Tag cardinality growing faster than tag reuse: new tags invented per envelope instead of matching existing ones.

#### Mitigations the design could adopt

- Make `tags` and `subsystems` **closed-vocabulary at validation time** — reject envelopes that introduce a new value without an explicit taxonomy-update step. Forces the drift to surface as a visible action, not silent rot.
- **Drop `flows` from the envelope entirely**, or demote it to a free-text hint that the selector ignores. Don't let an unlearnable field poison retrieval.
- Weight retrieval primarily on `files` + path-derived `subsystems` (both mechanical), treat LLM-extracted fields as tiebreakers only. Degrades gracefully when extraction is bad.
- Continuously evaluate extractor F1 per field against a small rotating human-labeled gold set; auto-disable any field whose F1 drops below threshold and fall back to mechanical-only for that field.

---

### 3.7 Selector calibration

#### Failure narrative

Month 1: one-hop works on the demo. Decisions link to the ADRs they implement; pulling a decision pulls its parent. Month 2: a refactor decision supersedes an earlier decision that itself refines an architectural principle. The principle is two hops away and the agent silently violates it. Someone files a bug. The fix is "also walk supersedes chains transitively" — a special case. Month 3: contradicts links start firing across the graph; an unrelated contradicted-by atom from a different subsystem gets injected on every pod touching auth. Weight `contradicts` lower. Now there's a weights table. Month 4: per-kind budgets appear — decisions get 2 hops, examples get 0, gotchas get 1 but only if tag-matched. The selector grows a config file. Month 5: agents notice push misses things and start calling `pull` on every task as a safety net; push-primary is dead in practice but still claimed in the docs. Month 6: the "deterministic, debuggable selector" requires reading 400 lines of weighting logic plus a YAML to predict what any pod will see. Three engineers have opinions about the weights. Nobody wants to own it.

#### Underlying assumptions that proved false

- That "one hop" is a property of the graph rather than a property of each link-type. `refines` and `supersedes` are transitive in meaning; `related` barely is.
- That parent intent lives exactly one hop away. Decision chains in real codebases are 3-5 deep; principles sit at the root.
- That link semantics would stay clean. In practice authors conflate `related` with `implements` and `contradicts` with `supersedes`, so hop-walks pull in semantically wrong neighbors.
- That a deterministic selector is automatically debuggable. Determinism without locality means "I can reproduce why this junk got included," not "I can predict what will get included."
- That the pull-tool would remain an escape hatch. Once agents learn push is lossy, pull becomes the primary interface and push becomes ceremony.

#### Early warning signs

- `pull_context` invocation rate climbs past ~30% of pods; trending toward "every pod calls it once."
- Average atoms-injected-per-pod drifts upward (e.g. 8 → 18) without a corresponding rise in atom quality signals.
- The selector config file gains commits — kind weights, hop overrides, tag blocklists — at a rate of >1/week.
- Bug reports of the form "agent didn't know about X even though X is linked" cluster around specific link-types (usually `supersedes` chains).
- Post-hoc "why was this atom included?" questions in incident reviews take >5 minutes to answer.

#### Mitigations the design could adopt

- Replace uniform hop count with **per-link-type transitive closure**: walk `refines`/`supersedes`/`implements` to fixpoint (with a cycle guard), walk `related`/`contradicts` zero hops unless tag-matched.
- **Relevance scoring with a budget**, not a hop count: score each candidate atom (anchor match, tag overlap, link distance, recency, kind priority), inject top-N within a token budget. Tunable in one place.
- **Hybrid push-then-search**: push the deterministic core, then let the agent issue one structured `expand(atom_id, reason)` call rather than free-form pull. Keeps the audit trail; admits that selection is iterative.
- **Selection traces as a first-class artifact**: every pod emits "atoms considered, atoms included, atoms dropped, with reasons." Makes the knob factory honest and gives a dataset to eventually learn against.

---

### 3.8 Too-late paradox

#### Failure narrative

Month 1: Team adopts the system. First pods work on greenfield areas — payments, the new scheduler, the mobile sync layer. Each pod runs without atoms, makes reasonable-but-arbitrary choices (retry with exponential backoff, 5 attempts, jitter), and the distill step captures these as atoms: "constraint: payment retries use exponential backoff with max 5 attempts." A human reviewer, lacking strong opinions on a decision they never made, approves it. The atom is now canonical.

Month 3: A second pod touches payments. It retrieves the atom, treats it as load-bearing intent, and builds around it. The retry policy ossifies — not because anyone designed it, but because Claude picked it and nobody pushed back during distill review.

Month 6: An architect proposes changing retry behavior for a real business reason (idempotency keys now available). They discover the codebase is shaped around an atom that encodes a decision no human ever made. The "intent corpus" is actually an archaeology of agent improvisation, retroactively legitimized by tired PR reviewers. New pods inherit agent-flavored architecture as gospel. **The system has laundered guesses into requirements.**

#### Underlying assumptions that proved false

- That distill reviewers would reject atoms representing arbitrary agent choices — in practice, reviewers can't distinguish "agent chose this" from "this was required" without re-doing the analysis.
- That pre-existing design documents would seed the corpus organically — nobody backfills; the corpus starts empty and stays distill-only.
- That "intent" is recoverable from outcomes. It isn't. You can extract *what* was done, not *why it had to be that way*.
- That the first-pod penalty would be small because greenfield work is rare. In a growing codebase, greenfield is the majority of high-stakes work.
- That human approval in a PR equals human authorship. Approval under review fatigue is closer to rubber-stamping than authorship.

#### Early warning signs

- Ratio of human-authored atoms to distill-authored atoms trending toward zero (target should be >30% human-seeded in active areas).
- Atom text reading like postmortems ("we used X because it worked") rather than directives ("X is required because Y").
- Architects' design docs and the atom corpus diverging — a `git diff` of `docs/decisions/` vs. atom store shows no cross-references.
- Pods citing atoms whose original distill PR had <2 substantive review comments.
- New-subsystem pods producing 10+ atoms in their first run (high distill yield = high improvisation rate, not high learning).
- Atoms getting "corrected" by later atoms instead of revised — a sign the original was a guess, not intent.

#### Mitigations the design could adopt

- **Pre-work atom capture in `/prep`**: the interview should produce *constraint* and *decision* atoms before the pod runs, not just a brief. Distill then refines, not originates.
- **Provenance tagging**: every atom carries `source: human-prep | distill-approved | doc-import`, and retrieval can weight or filter by provenance. Pods can be told "treat distill-only atoms as suggestions, not constraints."
- **Seed import from `docs/decisions/` and ADRs**: a one-time and ongoing pipeline that converts existing architecture docs into atoms, so greenfield areas aren't actually empty.
- **Distill quarantine for first-pod-in-area**: atoms from a pod working in a virgin area enter a "provisional" tier and require a second pod (or human design review) to promote them to canonical.

---

## Phase 4 — Synthesis

### Most probable failure (the slow fade)

**Curation collapse compounded by anchor rot.** This is the death by attrition. Atom authoring slows after sprint 1; anchors break during routine refactoring faster than they're repaired; the "review affected atoms" PR checkbox becomes ceremonial within a month; the corpus silently rots. The system never crashes — it just stops being useful, then stops being trusted, then gets disabled.

This is the most likely outcome because it doesn't require any single failure to be dramatic. It only requires the *cumulative cost* of curation to exceed the *visible value* of retrieval. That's a default state, not an unusual one.

### Most damaging failure (the empirical disproof)

**Atoms prime exploration regardless of selectivity.** If the AGENTS.md study's finding generalizes — and the deep-dive agent's exploration-ratio mechanism (2.3× more file opens with even one injected atom) suggests it might — then the entire design is net negative. Tighter anchors don't fix it. Better kinds don't fix it. Selector improvements don't fix it. The act of injecting any flagged-as-important context *changes how the agent treats the task*, and that change is bad more often than it's good.

This is the most damaging because it invalidates every other piece of work in the design. You can't fix it by polishing — you have to redesign the injection mechanism entirely (or stop injecting).

### Central hidden assumption

The whole design rides on **one load-bearing bet**: that selective, scoped, kind-ordered injection produces fundamentally different agent behavior than the flat always-on injection the AGENTS.md study tested.

If true, the design has a path. If false, the design is a more polished version of a known-bad pattern, and no amount of architecture saves it.

There are also two secondary load-bearing assumptions worth naming:

- **That intent is capturable through distillation after-the-fact.** The too-late paradox deep-dive showed this is false at the seam between agent-driven and human-driven design. You can extract *what was done* but not *what was required*.
- **That a deterministic selector with one-hop graph is debuggable in practice.** The calibration deep-dive showed determinism without locality only buys you reproducibility, not predictability.

### Plan revisions (mapped to failures)

| Failure addressed | Revision |
|---|---|
| 3.1 empirical disproof | **Gate launch on ablation eval, not lint/golden tests.** Require +3pp success delta on a frozen benchmark before any user sees injected atoms. Commit explicit kill criteria in writing. |
| 3.1 empirical disproof | **Default OFF for simple task classes.** Inject only for novel/architectural work; otherwise let the agent work without atoms. |
| 3.1 empirical disproof | **Ship telemetry before content.** Push/pull/gap-rate/exploration-ratio dashboards in week 1, with atoms behind a flag. |
| 3.1 empirical disproof | **Consider "inject by reference, not content".** Surface atoms as `context.search` results the agent must explicitly fetch — converts priming into pull. |
| 3.2 curation collapse | **Shift curation left, into the agent.** Agent proposes atom edits in the same PR as code edits; reviewer sees both together. |
| 3.2 curation collapse | **AST-symbol staleness, not just file churn.** Tree-sitter detects when anchored symbols change; surfaces in PR comment, blocks merge until acknowledged. |
| 3.2 curation collapse | **Atoms decay to `archived` automatically** if unverified for N weeks. |
| 3.3 wiki-ification | **Lint on shape, not just size.** Reject atoms with >1 H2, >N top-level bullets, or >1 frontmatter kind. Cap at ~40 lines, not 80. |
| 3.3 wiki-ification | **Require `claim:` field in frontmatter** (one sentence). CI checks the body supports exactly that claim. |
| 3.3 wiki-ification | **Retrieval anti-incentive.** Selector penalizes atom length so fat atoms lose ranking; removes the gradient toward bloat. |
| 3.4 kind collapse | **Launch with TWO kinds, not three** — `rationale` and `constraint`. Intent-vs-decision is the blurry boundary; constraint is sharp. |
| 3.4 kind collapse | **Structural templates per kind.** Mandatory sections enforced by lint. |
| 3.4 kind collapse | **Inter-rater calibration in CI**: periodic LLM re-classification of kind-stripped atoms; flag drift. |
| 3.5 anchor rot | **Symbol-based anchors via tree-sitter** (`file.ts#symbolName`) as the primary form; path-only anchors deprecated for new atoms. |
| 3.5 anchor rot | **Git hook auto-rewrites anchors on renames.** Detect via `git log --follow --name-status -M`. |
| 3.5 anchor rot | **Block lint-disable escape hatch.** Orphans become CI errors after 7-day grace, forcing fix-or-delete. |
| 3.6 envelope weakness | **Closed-vocabulary `tags` and `subsystems`.** Schema validation rejects unknown values; taxonomy update is an explicit visible action. |
| 3.6 envelope weakness | **Drop `flows` from envelope** or demote to a free-text hint the selector ignores. |
| 3.6 envelope weakness | **Continuous per-field F1 monitoring**; auto-disable any field whose extractor F1 drops below threshold. |
| 3.7 selector calibration | **Per-link-type transitive closure**, not uniform one-hop. `refines`/`supersedes`/`implements` walk to fixpoint; `related`/`contradicts` zero hops. |
| 3.7 selector calibration | **Relevance scoring with a token budget**, not hop counts. Single tunable place. |
| 3.7 selector calibration | **Selection traces as a first-class artifact** per pod, with reasons for inclusion and exclusion. |
| 3.8 too-late paradox | **Pre-work atom capture in `/prep`.** Interview produces atoms before the pod runs, not just an envelope. |
| 3.8 too-late paradox | **Provenance tagging** (`source: human-prep | distill-approved | doc-import`). Retrieval can weight or filter by provenance. |
| 3.8 too-late paradox | **Seed import from `docs/decisions/` and existing ADRs** so greenfield areas aren't empty. |
| 3.8 too-late paradox | **Distill quarantine for first-pod-in-area.** Atoms from virgin-area pods enter a `provisional` tier; require a second pod or human design review to promote. |

### Secondary risks (not deep-dived but mitigated by the above)

| Risk | Coverage |
|---|---|
| Non-autopod adoption | Defer standalone-tool extraction until pilot proves value. Initial CLI thin; iterate from real usage. |
| Distill quality | Provenance tagging + first-pod quarantine. |
| Maintainer bus factor | Don't build the CLI as a separate repo until one consuming team has stable adoption. |
| Schema versioning | Ship v0 minimal; defer schema-evolution story to post-pilot. |
| Privacy boundary | Per-atom `visibility: public | internal` field; CI enforces public atoms cannot reference internal atoms. |

---

## Phase 5 — Pre-launch verification checklist

### Before any user sees an atom

- [ ] **Ablation harness** running, producing daily success-rate delta with vs. without atoms, on a frozen benchmark of ≥50 tasks.
- [ ] **Kill criteria** written down in this document with explicit numbers (suggested: retire the system if success-rate delta < +3pp after 60 days, OR drops below 0 in any single week after corpus > 30 atoms).
- [ ] **Exploration-ratio metric** instrumented: files-opened-in-first-5-tool-calls (atoms-on / atoms-off). Alert threshold: 1.5×.
- [ ] **Pilot repo selected — NOT autopod itself.** Too close to home hides ergonomic problems. Suggest: a colleague's project with mixed AI tooling.
- [ ] **Default OFF for simple task classes.** Atoms inject only for tasks flagged novel/architectural. Threshold tunable.

### Schema and lint

- [ ] **Launch with TWO kinds only**: `rationale` and `constraint`. Defer `intent` until two-kind taxonomy is stable.
- [ ] **Shape lint**: reject >1 H2, >N top-level bullets, >1 frontmatter kind, >40 lines.
- [ ] **`claim:` field** required; LLM CI check validates body supports exactly that claim.
- [ ] **Symbol-based anchors** (tree-sitter) as primary form; path-only deprecated for new atoms.
- [ ] **Closed-vocabulary** `tags` and `subsystems`; taxonomy update is an explicit PR.
- [ ] **Provenance field** (`source: human-prep | distill-approved | doc-import`) required on every atom.

### Workflow

- [ ] **Pre-work atom capture in `/prep`** producing atoms before the pod runs.
- [ ] **Seed import** from existing `docs/decisions/` / ADRs / architecture docs.
- [ ] **Agent proposes atom edits in same PR as code edits** (curation rides on PR review habit).
- [ ] **AST-symbol staleness detection** via tree-sitter; surfaces in PR comments.
- [ ] **First-pod quarantine** for atoms authored in virgin areas.
- [ ] **Git hook** for anchor rewriting on rename.

### Selector

- [ ] **Per-link-type transitive closure**, not uniform one-hop.
- [ ] **Relevance scoring with token budget**, not hop count.
- [ ] **Selection traces** emitted per pod (atoms considered, included, dropped, with reasons).
- [ ] **Retrieval anti-incentive** for long atoms (length penalty in scoring).

### Telemetry SLOs (define before launch, monitor weekly)

- [ ] Gap rate < 10% by day 60.
- [ ] Noise rate < 30% by day 60.
- [ ] Pull-tool invocation rate < 15% (push-primary discipline holding).
- [ ] Median atom length p50 < 30 lines, p90 < 50 lines.
- [ ] Orphan anchor rate < 5%.
- [ ] Human-authored atom share > 30% in active subsystems.
- [ ] Distill-proposed atom merge rate > 40%.
- [ ] Exploration-ratio (atoms-on / atoms-off) < 1.3.
- [ ] Success-rate delta with atoms > +3pp.

### Decision gates

- [ ] **Week 2 gate**: telemetry pipeline producing all metrics. If not, halt content rollout.
- [ ] **Day 30 gate**: ablation eval shows ≥0pp delta. If negative, halt and diagnose.
- [ ] **Day 60 gate**: ablation eval shows ≥+3pp delta AND noise/gap SLOs green. If not, redesign or retire.
- [ ] **Day 90 gate (standalone-tool extraction)**: if all above hold AND ≥1 non-autopod consumer is producing atoms, begin CLI extraction. Otherwise defer.

---

## Closing

The premortem surfaces one design-fatal risk (empirical disproof of selective injection) and two slow-fade risks (curation collapse, too-late paradox) that together account for most likely-failure outcomes. The mitigations cluster into a small number of architectural moves: gate launch on ablation eval, default off for simple tasks, ship telemetry first, symbol-based anchors, provenance tagging, shape-lint not just size-lint, two kinds not three, per-link-type transitive closure, and pre-work capture in `/prep`.

The single most important pre-launch action is the ablation eval. **Ship the measurement before the mechanism.** If atoms don't move the success-rate needle on a benchmark you trust, no amount of polish will rescue the design.
