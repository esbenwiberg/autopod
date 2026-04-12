# Research: AI Coding Agent Patterns & Lessons for Autopod

## Sources Analyzed
- OpenAI: "Harness Engineering: Leveraging Codex in an Agent-First World"
- OpenAI Cookbook: "Using PLANS.md for multi-hour problem solving" (ExecPlans)
- Stripe: "Minions" Parts 1 & 2
- matklad: "ARCHITECTURE.md"
- Logic Inc: "AI Is Forcing Us To Write Good Code"
- Plus ~20 linked/related articles from these sources

---

## 1. The "Harness Engineering" Paradigm

All sources converge on one idea: **the infrastructure around the agent matters more than the model itself.**

- **OpenAI** coined "harness engineering" -- the engineer's job shifts from writing code to designing environments, specifying intent, and building feedback loops
- **Stripe**: "The primary reason Minions work has almost nothing to do with the AI model. It has everything to do with infrastructure Stripe built for human engineers years before LLMs existed"
- **Logic Inc**: "Engineering is becoming beekeeping" -- you cultivate a healthy hive with automated guardrails
- **Martin Fowler**: Agent = Model + Harness. Harness = context engineering + computational sensors + garbage collection

### What this means for Autopod

**Autopod IS a harness.** It orchestrates agents in isolated containers with system instructions, validation, escalation, and network policies. These articles validate autopod's core architecture. The industry is converging on exactly the pattern autopod implements: container isolation + injected instructions + multi-phase validation + escalation to humans.

**Key gap**: Autopod focuses on the orchestration layer but could do more to help users build better harnesses within their projects (better CLAUDE.md generation, architectural guidance, quality tracking).

---

## 2. System Instructions & Context Engineering

### What the industry does

**OpenAI -- Progressive Disclosure ("map, not encyclopedia")**:
- ~100 line AGENTS.md injected into context, serving as a map with pointers to deeper docs
- "When everything is important, nothing is" -- agents pattern-match locally instead of navigating intentionally
- Repository is the system of record -- if knowledge isn't in the repo, it doesn't exist for agents

**Stripe -- Curated Context Assembly**:
- ~500 tools available via Toolshed MCP server, but only ~15 relevant tools curated per task
- Context assembly pipeline: gather data from multiple sources, score for relevance, prune to token budget
- Directory-scoped agent rules (not global) to avoid overflowing context

**matklad -- ARCHITECTURE.md**:
- Bird's-eye overview of the problem (not solution)
- Codemap: "where's the thing that does X?" and "what does this thing do?"
- Explicit architectural invariants (especially absence-based: "nothing in model depends on views")
- Name things, don't link them (links go stale; names are searchable)
- Keep it short and stable -- only document things unlikely to change

**Logic Inc -- Auto-Learning Instructions**:
- When a PR is merged, a prompt analyzes human reviewer comments and extracts lessons into CLAUDE.md
- Agent instructions improve automatically over time from human review feedback

### What this means for Autopod

Autopod's `system-instructions-generator.ts` already builds container CLAUDE.md with tiered content injection. Potential improvements:

1. **Progressive disclosure in generated instructions** -- keep the main injected CLAUDE.md short (~100 lines of map), with pointers to deeper docs the agent can read on demand via memory_read or file access
2. **Relevance scoring for injected sections** -- score section relevance against the task description; prune low-relevance sections to stay within token budget
3. **Auto-learning from session outcomes** -- when sessions succeed/fail, extract lessons into profile-level or global memory entries (similar to Logic Inc's PR review extraction)
4. **Architectural invariants section** -- encourage profiles to specify "what should NOT happen" (absence-based constraints), not just what should happen

---

## 3. Validation & Feedback Loops

### What the industry does

**Stripe -- Three-Tiered Feedback ("shift left")**:
- Tier 1: Pre-push hooks auto-fix in <1 second, local linters in <5 seconds
- Tier 2: Selective CI -- only tests relevant to changed files (from 3M+ total tests)
- Tier 3: CI retry with **hard two-round cap** -- if the agent can't fix it in 2 attempts, a third won't help
- Autofix patterns applied automatically for known failure types

**OpenAI -- Validation is Non-Negotiable**:
- Plans must include exact test commands, expected outputs, and behavioral acceptance criteria
- "Without tests, Codex verifies its work using its own judgment. Tests create an external source of truth"
- Custom linter errors **inject remediation instructions** directly into agent context -- linters teach, not just block
- Every milestone verified before proceeding to the next

**Logic Inc -- 100% Coverage + Fast Loops**:
- 10,000+ assertions finishing in ~1 minute
- Every `npm test` creates a brand new database, runs migrations, executes full suite
- "Short leash" principle: small change, check it, fix it, repeat
- Quality checks must be cheap enough to run constantly

### What this means for Autopod

Autopod already has strong multi-phase validation (build -> health check -> smoke test -> AI review). Key improvements:

1. **Tiered validation like Stripe** -- add fast pre-checks (lint, typecheck) that run during coding, not just after. Currently validation is a single phase after the agent finishes. Adding incremental checks during `running` state would catch issues earlier
2. **Hard retry caps** -- Stripe's empirical finding: 2 CI rounds max. Autopod has `maxValidationAttempts` (default 3) which is close. Consider making this more prominent and adding per-phase caps
3. **Linter-as-teacher pattern** -- when validation fails, the correction message (`buildCorrectionMessage()`) could include not just "what failed" but "how to fix it" with specific remediation steps (like OpenAI's custom linter pattern)
4. **Selective test execution** -- for large projects, profile config could specify which tests to run based on changed files, rather than running the full suite every time

---

## 4. Blueprints, ExecPlans & Structured Task Decomposition

### What the industry does

**Stripe -- Blueprints**:
- Workflow templates wiring **deterministic nodes** (git, lint, test) with **agentic nodes** (AI reasoning/coding)
- Deterministic steps are never left to "vibes" -- they are hardcoded
- Custom blueprints per team for specialized workflows (e.g., large-scale migrations)

**OpenAI -- ExecPlans**:
- Living documents with mandatory sections: Purpose, Context, Plan of Work, Concrete Steps, Validation, Recovery
- Living sections maintained throughout: Progress (timestamped checkboxes), Surprises & Discoveries, Decision Log, Outcomes & Retrospective
- Enabled Codex to work for 7+ hours from a single prompt; 25-hour experiment produced ~30k lines
- **Milestone-based progression**: goal -> work -> result -> proof, each independently verifiable
- "Durable project memory" -- spec/plan/constraints written in markdown files the agent can revisit

### What this means for Autopod

1. **Blueprint support** -- autopod could formalize the distinction between deterministic and agentic phases in session lifecycle. Currently `processSession()` is a ~3500-line monolith. Breaking it into composable blueprint nodes (provision -> inject -> code -> validate -> merge) would enable custom workflows per profile
2. **ExecPlan integration** -- the `report_plan` escalation tool already exists. Could be enhanced to generate structured ExecPlan documents that get injected into the agent's working directory and tracked through the session
3. **Milestone tracking** -- add milestone events to the session lifecycle. Agents report milestones via MCP; autopod tracks progress percentage and can surface it to users via WebSocket events
4. **Session forking** -- OpenAI recommends "fork the session" when context degrades rather than persisting. Autopod could support spawning a fresh session from a checkpoint with the previous session's state handed off via a structured artifact

### Blueprint/Workflow System -- Expanded Design

**The problem**: Today every autopod session follows one hardcoded flow in `processSession()`: provision -> spawn agent -> agent codes freely -> validate everything at the end -> merge. The agent has full autonomy during the `running` phase with no structured checkpoints. Validation only happens after the agent signals completion.

**What a blueprint system would look like for autopod**:

A blueprint is a profile-level configuration that defines a sequence of **steps**. Each step is either:
- **`deterministic`** -- a shell command or built-in operation that runs predictably (lint, test, build, git push). The daemon executes these directly in the container, not via the agent. If it fails, the result is fed to the agent as a correction.
- **`agentic`** -- the agent gets control with a scoped prompt (e.g., "implement the feature", "fix the lint errors", "write tests"). The agent runs until it signals completion or hits a timeout.

**Example blueprints**:

```yaml
# Default blueprint (what autopod does today, just made explicit)
steps:
  - type: agentic
    prompt: "Implement the task"
  - type: deterministic
    command: "{profile.buildCommand}"
  - type: deterministic  
    command: "{profile.testCommand}"
  - type: agentic
    prompt: "Fix any failures from the previous steps"
    condition: "previous_failed"

# Frontend blueprint with incremental checks
steps:
  - type: agentic
    prompt: "Implement the feature"
  - type: deterministic
    command: "npm run lint"
  - type: agentic
    prompt: "Fix lint errors"
    condition: "previous_failed"
  - type: deterministic
    command: "npm run build"
  - type: agentic
    prompt: "Fix build errors"
    condition: "previous_failed"
  - type: deterministic
    command: "npm test"
  - type: agentic
    prompt: "Fix failing tests"
    condition: "previous_failed"

# Migration blueprint
steps:
  - type: agentic
    prompt: "Write the database migration"
  - type: deterministic
    command: "npm run migrate"
  - type: agentic
    prompt: "Write tests for the migration"
  - type: deterministic
    command: "npm test -- --grep migration"

# Security audit (no coding, just analysis)
steps:
  - type: agentic
    prompt: "Review the codebase for security issues and produce a report"
```

**Key design decisions**:
- Blueprints are optional -- the default blueprint matches today's behavior exactly (backward compatible)
- Each deterministic step captures stdout/stderr and feeds failures to the next agentic step automatically
- The session manager becomes a blueprint executor that walks the step list, rather than a monolithic orchestrator
- Blueprint progress is visible via WebSocket events (step N of M, current step type/status)
- Profiles reference blueprints by name; blueprints can be shared across profiles

**Implementation approach**:
- Phase 1: Extract the existing `processSession()` phases into named step functions (pure refactor, no new features)
- Phase 2: Add a `Blueprint` type to profiles with a `steps` array
- Phase 3: Replace the `processSession()` main loop with a blueprint walker that executes steps in sequence
- Phase 4: Add the `condition` system for conditional steps

**Why this matters**: Stripe found that deterministic gates between agentic steps are the single biggest reliability improvement. The agent can't skip linting or ignore test failures when the harness enforces the sequence. It also makes `processSession()` much more maintainable by decomposing it into small, focused step handlers.

---

## 5. Container Isolation & Environment Design

### What the industry does

**Stripe -- Devboxes**:
- Cloud-based AWS EC2 instances with full source tree, warmed Bazel/typecheck caches, code gen services
- Spin up in <10 seconds from a warm pool
- **Same environments humans use** -- agents use the same devboxes, linters, CI, rule files
- No internet access, no production access -- security via isolation
- Agents run with full permissions and no confirmation prompts because blast radius is contained
- Disposable: if a devbox gets into a bad state, discard it

**OpenAI -- Repository as the Environment**:
- Initial scaffolding (repo structure, CI, formatting, package manager, framework) generated by Codex itself
- Even the AGENTS.md was written by Codex
- ~1M lines of code, zero manually written

### What this means for Autopod

Autopod's container architecture is already strong (Docker isolation, network policies, iptables firewall, memory limits, ACI support). Potential improvements:

1. **Warm container pools** -- pre-provision containers with repos cloned, deps installed, caches warmed. Stripe's 10-second spinup is a competitive benchmark. Currently autopod provisions fresh each time
2. **Container templates per stack** -- the `StackTemplate` concept exists but could be extended with pre-warmed images that include dependency caches
3. **Disposable-first mindset** -- make it trivial to discard and recreate containers mid-session if they get into a bad state, rather than trying to recover

---

## 6. Entropy Management & Quality Tracking

### What the industry does

**OpenAI -- Automated Garbage Collection**:
- Agents replicate existing patterns, **including bad ones**
- Initially spent 20% of time (every Friday) manually cleaning "AI slop" -- couldn't keep pace
- Solution: encode "golden principles" in the repo, run background Codex tasks that scan for deviations, update quality grades, and open targeted refactoring PRs
- Most cleanup PRs reviewable in under a minute and auto-merged
- A "doc-gardening" agent scans for stale documentation and opens fix-up PRs

**OpenAI -- Quality Grades**:
- A quality document grades each product domain and architectural layer
- Gaps tracked over time, providing visibility into technical debt accumulation

**Martin Fowler**:
- Garbage collection is the **most overlooked** component of harness engineering
- Three components: context engineering, computational sensors (linters/coverage), garbage collection

### What this means for Autopod

1. **Quality tracking per profile** -- add a quality grade system that tracks metrics across sessions (test coverage trend, validation pass rate, lint issues, merge success rate). Surface in CLI/desktop
2. **Automated cleanup sessions** -- profile option to periodically spawn "cleanup" sessions that scan for deviations from profile standards and open fix PRs
3. **Memory-based golden principles** -- use the existing memory system (global/profile scope) to store "golden principles" that get injected into every session's instructions
4. **Session outcome learning** -- when sessions fail, auto-extract lessons into profile memory (similar to Logic Inc's PR review extraction)

---

## 7. Escalation, Human Oversight & Agent-to-Agent Review

### What the industry does

**Stripe**:
- Hard two-round CI cap -- no infinite retries
- Minions have "submission authority but not merge authority" -- every PR gets human review
- Unattended by design -- no one watches during execution
- Blueprint step logging for debugging failures

**OpenAI -- Agent-to-Agent Review**:
- Codex reviews its own changes locally, requests additional agent reviews (local + cloud)
- Iterates in a loop until all agent reviewers satisfied
- Humans escalated only for genuine judgment: novel architecture, security, product direction
- "When agents fail, fix the harness, not the prompt" -- ask what capability/context/structure is missing

**Logic Inc**:
- AI code review prompt (~1,500 tokens) covering architecture, standards, security
- Human reviewer comments auto-extracted as lessons into CLAUDE.md

### What this means for Autopod

Autopod's escalation system is already rich (ask_human, ask_ai, report_blocker, action_approval, validation_override). Potential improvements:

1. **Agent-to-agent review before human escalation** -- add an optional "AI review" phase where a second agent reviews the PR before it goes to human review. The AI task review in validation is close to this but could be expanded
2. **Configurable retry policies** -- make CI retry caps and validation retry caps more prominent in profile config, with Stripe's 2-round cap as the recommended default
3. **Harness improvement feedback** -- when sessions fail repeatedly on similar issues, surface patterns to profile owners suggesting harness improvements (better instructions, additional tools, different validation) rather than just reporting failures
4. **Review lesson extraction** -- when humans provide feedback on PRs (via GitHub/ADO comments), auto-extract patterns into profile memory for future sessions

---

## 8. Multi-Runtime & Model-Agnostic Architecture

### Industry validation of Autopod's approach

- **Stripe**: "The model does not run the system; the system runs the model" -- architecture deliberately makes the LLM less important than surrounding infrastructure
- **OpenAI**: Codex surfaces through CLI, web, IDE, macOS app -- all powered by the same harness
- **All sources**: Consensus that infrastructure investment pays dividends regardless of which model is used

Autopod already supports Claude, Codex, and Copilot runtimes via the `Runtime` interface abstraction. This is validated as the right approach by industry leaders.

---

## 9. Key Metrics & Benchmarks from Industry

| Metric | Stripe | OpenAI | Logic Inc |
|--------|--------|--------|-----------|
| PRs/week | 1,300+ merged | 3.5/engineer/day | N/A |
| Container spinup | <10 seconds | N/A | N/A |
| Test suite speed | Selective from 3M+ | Per-milestone | <1 min for 10k assertions |
| CI retry cap | 2 rounds max | N/A | N/A |
| Pre-push hooks | <1 second | N/A | N/A |
| Local lint | <5 seconds | N/A | N/A |
| Codebase size | 100s of millions LOC | ~1M LOC (5 months) | Small team (6 people) |
| Token consumption | N/A | >1B tokens/day | N/A |
| Test coverage | N/A | N/A | 100% (enforced) |
| Human-written code | Mixed | 0% | Mixed |
| Human-reviewed | 100% (before merge) | 0% (agent-to-agent) | AI + human review |

---

## 10. Prioritized Recommendations for Autopod

### Already solvable via History Pod

A **history pod** is a special autopod pod with access to all sessions' complete history. The following recommendations can be addressed by running a history pod that analyzes past sessions and extracts patterns -- no core autopod code changes needed:

- **Session outcome learning** -- a history pod can analyze failed/successful sessions across a profile, identify recurring failure patterns, and write lessons into profile-level memory entries
- **Review lesson extraction** -- a history pod can scan merged PRs' human review comments, extract recurring feedback themes, and update the profile's CLAUDE.md sections or memory
- **Quality tracking / dashboarding** -- a history pod can compute pass rates, coverage trends, merge success rates across sessions and produce reports
- **Automated cleanup / golden principles** -- a history pod can analyze code patterns across sessions, identify deviations from standards, and spawn cleanup sessions

These are powerful because they leverage autopod's existing infrastructure (memory system, session history, profile config) without new features.

### Already covered by existing features

- **ExecPlan / structured plans** -- the `/prep` skill (`skills/prep.md`) already decomposes tasks into spec suites with briefs, contracts, ADRs, validation plans, and acceptance criteria. The `/exec` skill (`skills/exec.md`) orchestrates multi-brief execution with subagents, handover chains, dependency DAGs, parallel dispatch, and drift detection. This is functionally equivalent to OpenAI's ExecPlan pattern.
- **Session forking** -- already supported in autopod's session lifecycle
- **Configurable retry caps** -- `maxValidationAttempts` is already per-profile configurable (Stripe's 2-round finding validates this design; consider whether the default should be lowered)
- **Image warming / warm container pools** -- image warming already exists via `image-builder.ts` and `acr-client.ts` for Azure Container Registry. Pre-built images with deps/caches are already supported
- **Agent-to-agent review** -- the AI task review phase in `local-validation-engine.ts` (`runTaskReview`) already sends diff + task to a separate AI model for pass/fail review. This IS agent-to-agent review
- **Progressive disclosure in system instructions** -- the autopod-injected CLAUDE.md is already fairly structured (task, injected sections, MCP servers, skills, memory index). The bigger progressive-disclosure opportunity is for the **user's own project CLAUDE.md** -- helping users write better architecture docs following matklad/OpenAI patterns (bird's-eye overview, codemap, architectural invariants). This is a documentation/guidance concern, not a core code change

### Potential improvements to /prep and /exec from ExecPlan research

OpenAI's ExecPlan concept has a few patterns that could enhance the existing skills:
1. **Living document updates** -- ExecPlans mandate timestamped Progress, Surprises & Discoveries, and Decision Log sections that get updated as work progresses. Currently `/exec` tracks progress via handovers but the plan itself is static. Could add a "living plan" mode where the exec skill updates the spec's plan.md with real-time progress.
2. **Idempotence & recovery section** -- ExecPlans require explicit documentation of how to retry or roll back safely. Adding this to brief templates would improve reliability for long-running sessions.
3. **Context & Orientation for novice agents** -- ExecPlans write each section assuming the reader knows nothing about the repo. Briefs could include a "Context" preamble with key file paths and module explanations, improving subagent effectiveness.

### Recommendations requiring core autopod changes

#### High Impact, Lower Effort
1. **Linter-as-teacher pattern** -- enhance `buildCorrectionMessage()` with specific remediation steps, not just "what failed" but "how to fix it". Affects `local-validation-engine.ts`

#### High Impact, Higher Effort
2. **Blueprint/workflow system** -- formalize deterministic vs. agentic phases; allow custom workflows per profile. Major refactor of session-manager.ts (~3500 lines). **This subsumes "tiered validation"** -- blueprints let profiles define deterministic steps (lint, typecheck, test) between agentic steps, which IS tiered validation built into the workflow.

#### Strategic / Long-Term
3. **Context relevance scoring** -- score injected sections against task description; prune low-relevance content to stay within token budget. Affects system-instructions-generator.ts

---

## 11. Key Quotes Worth Remembering

> "Don't start with model selection. Start with your developer environment, your test infrastructure, and your feedback loops." -- Stripe

> "The repository must be entirely self-describing -- if knowledge is not in the repo, it doesn't exist for agents." -- OpenAI

> "When agents fail, fix the harness, not the prompt." -- OpenAI

> "It takes 10x more time to figure out WHERE to change the code than to write the patch." -- matklad

> "The walls matter more than the model." -- Stripe

> "Without tests, agents verify work using their own judgment. Tests create an external source of truth." -- OpenAI

> "Putting LLMs into contained boxes compounds into system-wide reliability upside." -- Stripe

---

## 12. Further Reading (Key Related Articles)

- [Anthropic: Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) -- Generator-evaluator pattern, multi-agent architecture
- [Anthropic: Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Martin Fowler: Harness engineering for coding agent users](https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html) -- Agent = Model + Harness framework
- [Logic Inc: Engineering Is Becoming Beekeeping](https://bits.logic.inc/p/engineering-is-becoming-beekeeping)
- [Logic Inc: Machine-Driven Code Review](https://bits.logic.inc/p/code-review-without-bottlenecks) -- Auto-extracting review lessons
- [Logic Inc: Losing Control Of Our Coding Agents](https://bits.logic.inc/p/losing-control-of-our-coding-agents)
- [Latent Space: Extreme Harness Engineering](https://www.latent.space/p/harness-eng) -- OpenAI's >1B tokens/day approach
- [OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- [OpenAI: Unlocking the Codex harness (App Server)](https://openai.com/index/unlocking-the-codex-harness/)
- [Stack Overflow: Coding guidelines for AI agents](https://stackoverflow.blog/2026/03/26/coding-guidelines-for-ai-agents-and-people-too/)
- [OpenAI: Run long horizon tasks with Codex](https://developers.openai.com/cookbook/examples/codex/long_horizon_tasks) -- 25-hour experiment, ~30k lines
