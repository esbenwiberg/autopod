---
name: code-council
description: >
  Code-grounded for/against debate for "should I build this?" or "should I do
  it like this?" questions. Scouts the relevant code, optionally interviews
  the user to lock down ambiguities, then runs two adversarial agents in
  parallel — one steelmans the idea, one steelmans against — both forced to
  cite file:line evidence. Synthesis names the decisive trade-off without
  picking a winner. Built to kill the yesman/noman problem on code decisions.
  NOT a replacement for /plan-feature, /prep, or Plan — those are for
  designing what to build once you've decided. This is for the decision
  itself.
allowed-tools: Read, Grep, Glob, Bash, Agent, AskUserQuestion
---

# /code-council

Adversarial, code-grounded decision support. Use when you have an idea and
suspect Claude is about to say "yes, great idea!" reflexively. The council
forces both sides to argue with evidence from the actual repo.

## When to use

- "Should I add feature X?"
- "Should I do it this way or that way?"
- "Is this refactor worth it?"
- "Are we right to rip out / keep / replace Y?"

The common thread: a binary or near-binary decision where you want to be
challenged before committing.

## When NOT to use

- **Pure factual lookups** ("where is X defined?") — just grep
- **Implementation details** ("map vs for loop") — too small, just write it
- **Bug fixes** — the bug doesn't have two sides
- **Large feature planning** — use `/plan-feature` or `/prep`
- **Already-written code review** — use `/ultrareview` or `/review`
- **Pure business decisions** (pricing, hiring) — Ole's LLM Council fits better

If you find yourself wanting the council for something that's clearly correct
or clearly wrong, the framing is the problem — sharpen the question first.

## The pipeline

```
Scout → Interview (adaptive, may skip) → For ‖ Against → Synthesis
```

Four phases, executed in order. Phases 3a/3b run in parallel.

### Phase 1: Scout

Spawn ONE Explore agent to map the territory. Brief it with:

- The user's verbatim question
- "Find every file/function/test relevant to this decision. Note existing
  patterns, callers, tests, and anything that would constrain the choice."
- "Report file:line references, not summaries. Under 400 words."

The scout output becomes the shared evidence base for every later phase.
Without this, the for/against agents will hallucinate code that doesn't
exist.

### Phase 2: Interview (adaptive — usually skip)

After reading the scout's report, decide whether the question has a
**load-bearing ambiguity** — something that would flip the verdict if
answered differently.

**Skip the interview if:** the question is concrete, the scout surfaces
obvious constraints, and a reasonable default exists. This is the common
case. Just say "scout was clear, going straight to debate" and proceed.

**Run the interview if:** there's a genuine fork. Examples:
- Hot path vs. admin tooling (perf budget differs by 100x)
- Ship-fast vs. clean-up motivation
- Backward-compat required vs. greenfield
- Single-team use vs. external API

Rules when interviewing:
- **One question per turn.** Never batch.
- **Hard cap: 3 questions.** If still ambiguous after 3, bail out:
  "the question isn't ready for council — clarify X first."
- Use `AskUserQuestion` so the user can pick from concrete options.
- After each answer, decide again whether more is needed. Stop early if
  it's clear.

### Phase 3: For ‖ Against (parallel)

Spawn TWO Agent calls in a **single message** — they must run concurrently.
Both get identical input: scout report + interview answers (if any) + the
user's verbatim question.

#### 3a — The Advocate (For)

Brief:
> Steelman this idea. Find at least 3 reasons it should ship, each grounded
> in a specific `file:line` from the scout report or your own grep. Reasons
> without evidence get dropped. No vibes, no "this would be cleaner" — show
> me the existing pattern, the gap in coverage, the code smell, the TODO.
> Under 300 words. Format: numbered list, each item starts with the
> `file:line` citation.

#### 3b — The Skeptic (Against)

Brief:
> Steelman the rejection. Find at least 3 reasons NOT to do this, each
> grounded in `file:line` evidence. Look for: existing alternatives in the
> repo, hidden coupling, blast radius, scope creep, tests that would break,
> patterns this contradicts. No lazy contrarianism — every objection must
> point at code. Under 300 words. Same format as the advocate.

**Citation rule (non-negotiable for both):** any claim without a `file:line`
reference is dropped before synthesis. Tell each agent this explicitly.

### Phase 4: Synthesis

You (the orchestrator) write the synthesis. Do NOT spawn an agent for it —
that just adds another layer of sycophancy.

Format:

```
## Council verdict

**The decisive variable:** <name the one trade-off that actually matters>

**Strongest For:** <best citation-backed point from advocate>
**Strongest Against:** <best citation-backed point from skeptic>

**Where they agreed:** <if anything>
**Where they clashed:** <the real fork>

**My read:** <one sentence — name the asymmetry, do NOT pick a winner unless
the evidence is genuinely lopsided. If it is lopsided, say so plainly.>
```

The synthesis must:
- Name **one** decisive variable, not five
- Quote the strongest citation from each side
- Refuse to mush. "Both sides have merit!" is a failure mode — name the
  actual fork
- Leave the call to the user unless one side is clearly wrong on the
  evidence

## Anti-patterns to avoid

- **Skipping the scout.** Without code evidence, the for/against agents
  argue vibes. Pointless.
- **Always interviewing.** Friction kills the skill. Default to skip.
- **Picking a winner in synthesis when the evidence is balanced.** That's
  just sycophancy in a debate costume. Name the trade-off and stop.
- **Running for/against sequentially.** Parallel only. Sequential lets the
  second agent react to the first, which collapses independence.
- **Letting either side argue without citations.** Drop uncited claims
  before they reach synthesis.

## Invocation

User says `/code-council <question>` or just describes an idea and asks for
council on it. Run all four phases. Do not write files — output stays in
chat.
