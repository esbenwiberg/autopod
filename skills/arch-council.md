---
name: arch-council
description: >
  Axis-based comparison for arch / tech-stack / framework decisions where
  multiple options are viable and the right answer depends on which
  trade-off you weight most. Scouts the repo for constraints + identifies
  the incumbent, optionally interviews for context, then runs 3–5 "axis
  hawks" in parallel — each ranks every option on one axis (type-safety,
  ship-speed, ops-cost, etc.) with citations. Synthesis is a comparison
  matrix with load-bearing axes named, not a winner pick. Designed to
  kill LLM novelty bias and prevent framework-brochure output. NOT for
  binary "should we do this?" — that is /code-council. NOT for designing
  what to build — that is /plan-feature.
allowed-tools: Read, Grep, Glob, Bash, WebFetch, WebSearch, Agent, AskUserQuestion
---

# /arch-council

Adversarial, axis-grounded comparison of architectural / tech-stack /
framework options. Use when you have 2+ viable choices and the right call
depends on which constraint matters most — not on which is "best." Each
axis hawk ranks every option on its axis with evidence; you read the
matrix and own the call.

## When to use

- "Postgres, SQLite, or DuckDB for this service?"
- "React Query vs SWR vs roll-our-own?"
- "Monolith, modular monolith, or microservices?"
- "Auth0, Clerk, Supabase, or build it?"
- "CLI, daemon, or web service?"

Common thread: 2+ options, all reasonable, decision hinges on which
constraint you weight most.

## When NOT to use

- **Binary "should I build this?"** — `/code-council`
- **Already decided, need a plan** — `/plan-feature` or `/prep`
- **Implementation-detail comparison** ("Map vs Set", "for vs while") —
  too small. Just write it.
- **Greenfield with zero constraints** — no scout grounding = brochure
  output. Define one hard constraint first.
- **Pure preference questions** ("vim vs emacs") — no.

If you find yourself wanting council for something with an obvious
incumbent and no real challenger, sharpen the question first.

## The pipeline

```
Scout → Interview (adaptive) → Axis selection → N hawks ‖ → Matrix synthesis
```

Five phases, in order. Phase 4 hawks run in parallel.

### Phase 1: Scout

Spawn ONE Explore agent to map the constraints. Brief it with:

- The user's verbatim question + candidate options if listed
- "Map the existing stack, deploy targets, infra, test patterns, and any
  code that would constrain or be displaced. Identify the **incumbent** —
  whatever is already in the repo for this slot, even if the user wants
  to replace it. Note team conventions inferred from code (language,
  strictness, test runner, HTTP lib, build tool)."
- "Report file:line references, not summaries. Under 400 words."

Scout output establishes (a) constraints every hawk must respect, and (b)
the incumbent baseline — the anti-novelty guard. Without scout grounding,
hawks hallucinate frameworks and trend-chase.

### Phase 2: Interview (adaptive)

Arch questions arrive vague more often than code-council questions.
Interview only when the answer would meaningfully shift which axes
matter. Stay disciplined.

**One question per turn. Hard cap: 3.** Use `AskUserQuestion` so the user
picks from concrete options.

Common load-bearing forks:
- **Time horizon** — ship-this-week vs. live-with-it-for-three-years
- **Reversibility** — one-way door (DB) vs. soft (UI lib)
- **Scale ceiling** — 100 users vs. 10M users
- **Team shape** — solo vs. small team vs. large org with separate ops
- **Existing pain** — replacing something painful vs. greenfield slot
- **Budget** — self-host-on-a-VPS vs. enterprise-SaaS-OK

**Skip if** scout pinned these down or the question states them. Default
to skip — friction kills the skill.

### Phase 3: Axis selection

You (orchestrator) pick **3–5 axes** that actually decide this question,
based on scout + interview. Don't run them all — noise dilutes signal.

Common axes (pick from these, or invent ones that fit):

| Axis | Picks when... |
|---|---|
| **Type-safety** | language/runtime, schema layer, API contracts |
| **Ship-speed** | early-stage, deadline pressure, MVP framing |
| **Ops cost** | self-host vs SaaS, infra complexity, on-call burden |
| **Team-onboarding** | hiring, handoff, contributor friction |
| **Ecosystem maturity** | libraries, hiring pool, Stack Overflow depth |
| **Reversibility** | one-way doors (DB, auth, vendor lock-in) |
| **Performance** | hot path, latency budget, throughput target |
| **Security surface** | auth, secrets, multi-tenancy, attack surface |
| **Long-term maintenance** | dep churn, breaking-change cadence, EOL risk |

Announce the picks in chat — "running these 4 axes: X, Y, Z, W" — so the
user can redirect if you missed something obvious.

### Phase 4: Axis hawks (parallel)

Spawn one Agent per axis in a **single message**. MUST run concurrently —
sequential = each agent reacts to the previous, collapsing independence.

Each hawk gets identical input:
- The user's verbatim question
- The full list of options
- Scout report (constraints + incumbent)
- Its assigned axis (only one)

Brief template (substitute axis name):

> You are the **{axis} hawk**. Rank the options on **{axis} ONLY** — ignore
> every other dimension, even if the answer feels lopsided.
>
> Rules:
> 1. Every claim about this codebase needs a `file:line` citation from the
>    scout report or your own grep.
> 2. Every claim about a framework/tool needs a primary-source URL —
>    official docs, RFC, benchmark, GitHub issue. No "I recall" or
>    "in general."
> 3. The **incumbent** ({scout's incumbent}) wins ties on your axis. Only
>    rank a challenger above it if your axis genuinely demands it — and
>    say why with evidence.
> 4. Output: ranked list (best → worst on YOUR axis), one sentence per
>    option with the citation inline. Then one line:
>    **"Decisive on {axis}: {top option} by {how much} because {one-clause
>    reason}"** or **"Tie on {axis}"** if the gap is small.
> 5. Under 250 words.

Citation rule is non-negotiable. Tell each hawk: *uncited claims dropped
before synthesis.*

### Phase 5: Matrix synthesis

You (orchestrator) write the synthesis. Do NOT spawn an agent — adds
another sycophancy layer.

Build the matrix first (use `+` for clear win, `~` for tie/middle, `-`
for clear loss; mark the incumbent):

```
                  | Axis A | Axis B | Axis C | Axis D |
Option 1          |   +    |   ~    |   -    |   +    |
Option 2 (incum)  |   ~    |   +    |   +    |   ~    |
Option 3          |   +    |   -    |   ~    |   -    |
```

Then write:

```
## Council verdict

**Matrix:** <the table above>

**Load-bearing axes for this decision:** <1–2 axes the user's context
made non-negotiable per interview / scout. Not all axes are equal.>

**Where the hawks agreed:** <any option dominating multiple axes>
**Where they clashed:** <the actual fork — usually two options trading
wins across load-bearing axes>

**Incumbent check:** <does the matrix justify moving off the incumbent?
If no high-weighted axis favors a challenger, name that plainly.>

**My read:** <one sentence. Pick a winner ONLY if one option dominates
every load-bearing axis. Otherwise: "fork is X — weight A → pick 1,
weight B → pick 2.">
```

The synthesis must:
- Show the full matrix — don't hide axis disagreements
- Name **load-bearing** axes explicitly (not all count equally)
- Refuse to mush. "All options have merit!" is a failure mode
- Default to the incumbent unless the matrix gives a real reason to move
- Leave the call to the user unless one option genuinely dominates

## Anti-patterns

- **Skipping the scout.** Without constraints + incumbent, hawks argue
  brochure abstractions. Useless.
- **Running 8+ axes.** Noise. Pick the 3–5 that matter for this question.
- **Sequential hawks.** They contaminate each other. Parallel only.
- **Uncited claims.** `file:line` for repo, URL for external. Uncited =
  dropped before synthesis.
- **Forgetting the incumbent.** LLMs default to recommending the new
  shiny. Anti-novelty guard is mandatory — every hawk respects it,
  synthesis flags challenger picks explicitly.
- **Picking a winner on a mixed matrix.** Sycophancy in a debate costume.
  Name the load-bearing axes and stop.
- **Prose-only synthesis.** Hides axis disagreements. Always show the
  matrix.

## Invocation

User says `/arch-council <question>` or describes a stack/framework/
approach choice and asks for council. Run all five phases. Output stays
in chat — do not write files.
