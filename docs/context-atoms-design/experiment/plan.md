# Experiment plan — two-week ablation

## The bet under test
Selective, scoped injection of atoms produces fundamentally different agent behavior than flat always-on injection.

Operationalized: with atoms injected (anchor-matched, no selector polish), does agent task success go UP, exploration go DOWN, and cost stay flat?

## Pre-launch discipline (premortem-driven)
- **Pilot repo is NOT autopod.** See `../decisions/006-pilot-not-this-repo.md`.
- **Kill criteria are written down BEFORE running.** See Stage 4.
- **Telemetry shipped BEFORE atoms.** Exploration-ratio metric instrumented first.

## Stages

### Stage 1 — Extract atoms (3–4 days)
- Run extractor (see `extractor.md`) over the pilot repo's existing docs: ADRs, READMEs, CONTRIBUTING, any package docs.
- Validate atoms with shape lint (≤30 lines, one claim, anchors resolve).
- Expect 30–60 atoms.
- **If extraction yields <15, the pilot repo is too doc-sparse — stop and pick another.**

### Stage 2 — Mine benchmark tasks (1–2 days)
- Find ~15 recent merged PRs in the pilot repo where:
  - A specific test went red → green (or a new test passes after the PR's changes).
  - The PR is small (< ~300 LOC diff).
  - The issue/PR title alone conveys intent (no need to see the diff).
- Strata:
  - ~5 simple (rename, typo, single-file fix)
  - ~7 medium (cross-file change, new endpoint)
  - ~3 novel (new subsystem, architectural change)

### Stage 3 — Runner (2–3 days)
- For each task, check out the pre-PR SHA.
- Strip the PR's source changes (keep any new test that's the success criterion).
- Spawn agent with the issue text as the prompt. Cap at N tool calls or M minutes.
- Apply the agent's diff, run the success test.
- Two arms per task: with atoms injected (anchor-match → system prompt, no selector), without atoms.
- 3 samples per (task, arm) for non-determinism. Total: 15 × 2 × 3 = **90 runs**.
- Capture per run: pass/fail, tool calls, files opened in first 5 calls, tokens, duration.

### Stage 4 — Decide (1 day)

| Metric | Green | Yellow | Red |
|---|---|---|---|
| Success delta (atoms − no-atoms) | ≥ +3pp overall | 0 to +3pp | < 0 |
| Exploration ratio (atoms-on / atoms-off) | ≤ 1.3 | 1.3 – 1.5 | > 1.5 |
| Simple-task delta | ≥ 0 | -2 to 0 | < -2 |
| Token cost overhead | ≤ +15% | +15 to +25% | > +25% |

- **All green** → build the selector, the CLI, the MCP.
- **Mixed** → narrow scope (e.g., only inject on novel-task class).
- **Any red** → stop. Do not polish. Diagnose or abandon.

## Cost
~$150–400 in agent runs. Half a day of wall-clock if parallelized.

## What this experiment does NOT build
- The selector.
- The link graph.
- Kind ordering.
- Closed-vocabulary tag taxonomy.
- The standalone CLI or MCP server.

All deferred until the bet is proven. **Ship the measurement before the mechanism.**
