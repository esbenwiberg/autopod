---
name: plan-feature
description: >
  Decomposes a large feature into a series-ready spec folder for `ap series create`.
  Runs a continuous interview-plus-research loop with one question per turn,
  scanning the codebase between answers, until every coverage dimension is green.
  Then writes `specs/<name>/` with `purpose.md`, `design.md`, `briefs/`, and any
  new ADRs into the repo-level `docs/decisions/`.
  Use when the task spans 3+ modules or 4+ hours of work.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit, Agent, AskUserQuestion
---

# /plan-feature

Turn a rough feature idea into a fully structured `specs/<name>/` folder that
`ap series create specs/<name>/` (or `ap series create specs/<name>/briefs/`)
can execute without any further clarification. Nothing is written until the
exit checklist is fully green and the user has confirmed.

## When to use

- Task touches 3+ modules or will take more than ~4 hours
- You need independent validation checkpoints between work phases
- You want the work split across parallel or sequential agent pods

If the task is clearly single-checkpoint (one module, a few files), recommend
`/prep` instead.

## How this works

A continuous interview-plus-research loop — not a fixed set of phases. The loop
runs until the exit test passes. Then and only then does it write output.

```
scan codebase → surface finding → ask ONE question → wait for answer →
scan codebase again → ask ONE question → wait → ... → exit test passes → write
```

### Rules (non-negotiable)

- **One question per turn. Full stop.** Never batch two questions.
- After every answer, search the codebase again before forming the next
  question. New answers open new search paths — always follow them.
- If the codebase already answers a question, don't ask — cite the finding
  and move on.
- **If a fact or ADR answers a question, don't ask — cite it and move on.**
  Before forming any question, scan the loaded facts and ADRs for a match.
  If found, mark the dimension green and note the source inline
  (e.g. `📋 fact-003`, `📋 ADR-012`). Only escalate to the user when no
  fact, ADR, or codebase evidence covers it.
- Never draft `purpose.md`, `design.md`, briefs, or ADRs during the loop.
  Writing happens only after the exit test passes and the user has greenlit.
- **The coverage checklist is the only stop sign — not a question count.**
  A low question count is a symptom of skipping the interview, not a budget
  to spend.
- **Asymmetric signal:** if you're on question 3 of a 3+ module feature and
  feeling ready to write, you are almost certainly wrong — keep going. If
  you're on question 15 and the checklist is still red, keep going. There is
  no "enough" — only "checklist green, confirmed by user."
- **Bias toward more questions, not fewer.** Every ambiguous noun in the
  user's original prompt is a question waiting to happen. Pin them down one
  at a time.

### Opening move

Before asking anything, scan for 3–5 minutes:

1. What does existing code already handle in this area?
2. Where are the seams — places where one module hands off to another?
3. What shared types/interfaces cross module boundaries?
4. What's the test coverage like in the blast radius?
5. Load the knowledge indexes:
   a. Run `./scripts/generate-knowledge-index.sh` if the script exists
      (ensures indexes are fresh without loading every file).
   b. Read `docs/decisions/index.md` (or `decisions/index.md`,
      `docs/adrs/index.md` — match the existing ADR folder convention).
      If no index exists, fall back to reading every ADR directly.
   c. Read `docs/facts/index.md` if it exists.
   d. From both indexes, identify which ADRs and facts are relevant to
      this feature. Read only those full files — not every entry.
   Prior decisions are baseline knowledge; facts are pre-answered questions.
6. Are there CLAUDE.md sections, READMEs, or pinned docs the executor will
   need? Note them; they go into `design.md` → Reference reading.

Present a 3–5 bullet summary of findings. Ask the first question. Stop.

### Asking questions: option-style vs prose

Use `AskUserQuestion` with mutually exclusive options + an automatic "Other
(specify)" fallback **when the realistic answer space is a small set of
discrete choices**:

- "Should events use SSE, WebSockets, or polling?"
- "Auto-merge on green, or human-gated approval?"
- "New top-level route or extend an existing one?"

Use **prose** when the answer is open-ended (a list, a name, a description, a
file pointer) — those are usually answered by the codebase anyway:

- "Which endpoints feed this view?"
- "What's the empty-state copy?"
- "What does 'match the backend' mean here?"

Anti-pattern: don't rephrase a prose question as fake options ("Which
endpoints feed this view? A) /api/orgs B) /api/users C) Other"). The planner
shouldn't be guessing the codebase's answer — search instead.

### What to clear during the loop (coverage dimensions)

Each scan+question round resolves one of these. Every dimension must end up
green (answered by user, answered by codebase, or explicit N/A with
justification) before writing.

1. **Problem framing** — What is broken or missing? Whose problem?
   → `purpose.md` → Problem
2. **Outcome** — One sentence, observable change after this ships.
   → `purpose.md` → Outcome
3. **Success signal** — How will we know it worked?
   → `purpose.md` → Success signal (must be tied to a brief AC, see #14)
4. **Users / actors** — Who is affected? Who benefits?
   → `purpose.md` → Users
5. **Non-goals** — Explicit fence. The most useful thing for keeping the
   executor from over-reaching.
   → `purpose.md` → Non-goals
6. **Glossary** — Every noun in the prompt that two readers might interpret
   differently. Every ambiguous noun gets pinned.
   → `purpose.md` → Glossary
7. **Reversibility** — Hard-to-reverse changes (DB migrations, public API
   changes, on-disk format, deletions)? Required only when applicable; if so,
   note the rollback strategy.
   → `purpose.md` → Reversibility (omit when fully reversible)
8. **Blast radius** — Files / modules touched. With paths, not gestures.
   → `design.md` → Blast radius
9. **Seams** — Where does one module hand off to the next? These are the
   pod boundaries.
   → `design.md` → Seams + briefs/ ordering
10. **Cross-pod contracts** — Types, interfaces, API shapes, DB columns that
    cross brief boundaries. Owner per contract.
    → `design.md` → Contracts
11. **UX flows + wireframes** *(only when feature is user-facing)* — Entrypoint →
    states (loading / empty / error) → exits. Component list if a new screen.

    **Wireframe gate:** When the feature introduces a new screen OR significantly
    rearranges an existing surface (new panels, changed column structure, new
    persistent UI elements), produce an ASCII wireframe as part of clearing this
    dimension. **Show-and-ask, not ask-then-produce** — draw the wireframe inline,
    then ask "Does this match your vision?" Iterate until the user explicitly signs
    off. The approved wireframe is a blocking gate: the show-back cannot be
    greenlit until it carries an approved wireframe for every affected screen.
    A feature that modifies a user-visible layout without an approved wireframe is
    red in the coverage assessment — not amber, not N/A.

    → `design.md` → UX flows (approved wireframe inline under each affected flow)
12. **Reference reading** — Existing ADRs, CLAUDE.md sections, READMEs, and
    code patterns the executor should consult. Capture what you read during
    the scan, not at write time.
    → `design.md` → Reference reading
13. **Pod sizing** — Is any brief's `Touches` list approaching 8 files? Then
    split. Rule of thumb: > 8 files = too big.
    → briefs/ structure
14. **Acceptance criteria** — Per brief, only when a real automated check
    validates the behaviour. The validation pipeline runs `buildCommand`
    and the test suite automatically — **never list build/test/lint as
    ACs**.

    **Core principle: an AC validates the OUTCOME, not the wiring.** Run
    the test "would this AC still pass if the user can't see or use the
    feature?" If yes, it's the wrong AC. File-exists / grep checks confirm
    code was written; they do not confirm the feature works. They
    corroborate; they never substitute for a behavioural check on a
    user-visible outcome.

    Three firing types exist:
    - `api` — HTTP probe against the running container (single request
      or short create-then-read chain). Don't use against endpoints
      requiring a role the test harness can't impersonate (`[Authorize]`
      / `RequiresUserType(<role>)`) — they 401.
    - `web` — browser DOM check via `validate_in_browser` (only when
      the profile has a web UI).
    - `cmd` — arbitrary shell command in the validation container, gates
      on exit code. For **structural / workspace-state** assertions:
      file existence, ref removal, JSON/YAML flag values, single named
      tests by filter. NOT for build / test / lint as a whole — those
      patterns are banned and force-classified to `none`. NOT for
      behavioural claims — those go to `api` / `web`.

    **Hard rule — user-visible outcomes require a `web` AC.** If the
    brief modifies any user-facing surface (component, page, route,
    visible string, layout) AND the profile has a web UI, at least one
    AC must be `type: web` that asserts the observable from the success
    signal. Structural `cmd` checks corroborate; they are never the only
    validation. A frontend brief whose ACs are all `cmd` is broken by
    definition — the user could ship a broken feature and every AC would
    still pass.

    **Type discipline — match the AC type to the verb in the outcome:**
    - "visible" / "renders" / "user sees" / "screen shows" → `type: web`
    - "endpoint returns" / "responds with" / "stores X" → `type: api`
      (or `web` for end-to-end)
    - "symbol removed" / "file exists" / "flag flipped" / "ref deleted"
      → `type: cmd`

    A `cmd` AC linked to a "visible" outcome is structural theatre — the
    feature can be broken with every AC green. Fix the AC type, or
    re-frame the outcome to match what you can actually validate.

    **Decompose fuzzy claims before writing ACs.** "X migrated to Y" /
    "X works with Y" / "X integrates with Y" / "Wire X into Y" should
    expand into 2–5 concrete checks, each pinned to a single observable.
    If a brief has one fuzzy bullet, the interview isn't done.

    Example (backend): "auth migrated to new middleware" →
    (a) `cmd: test -f Application/Auth/NewMw.cs`,
    (b) `cmd: ! grep -r OldMw Api/`,
    (c) `api: GET /api/protected without token → 401`,
    (d) `api: with valid token → 200`,
    (e) `cmd: grep '"auth": "migrated"' inventory.json`.

    Example (UI wiring): "wire total row into Resource Planner frontend" →
    (a) `web: navigate /resource-planner — total row visible below header
        with one cell per period column`,
    (b) `web: change the period filter — total row updates without full
        page reload`,
    (c) `cmd: grep -l 'RESOURCE_PLANNER_TOP_ROW' Client/src/.../queryKeys.ts`
        (corroborates query key wired),
    (d) `cmd: test -f Client/src/.../TopTotalRow.tsx` (corroborates new
        component exists).
    The `web` ACs validate the outcome; the `cmd` ACs corroborate the
    wiring. Reverse the proportions and the brief is broken.

    `type: none` exists but is a no-op — auto-passed and excluded from
    gating. Use it only when the diff reviewer is the only possible
    verification (rare). Prefer **zero ACs** + a thorough Test
    expectations section over padding with `none`. The success signal
    from #3 must be tied to a firing AC, or the success signal itself
    must be rewritten until it is.
    → briefs/*.md frontmatter
15. **Hard-to-reverse decisions** — Anything surprising or with long-lived
    consequences. ADRs are written **per decision**, numbered globally in
    `docs/decisions/` (not per spec).
    → `docs/decisions/ADR-NNN-<slug>.md`

If any dimension is hand-waved ("probably fine", "we can figure it out",
"TBD"), that's red — ask another question.

### Per-turn discipline

After each user answer, before forming the next question:

1. **Name the dimensions touched.** Briefly note which previously-green
   dimensions this answer affects (often more than one). Re-validate them.
   If any are now red, mark them red and re-open them — do not let earlier
   coverage decay silently.
2. **Re-scan the codebase** for anything the new answer opens up.
3. Then form the next question.

#### When the user defers ("you decide" / "whatever you think")

Do **not** silently decide. Propose a specific answer with a one-line
rationale and ask for confirmation:

> "Defaulting to SSE because the existing event bus already streams over
> SSE in `event-bus.ts:42`. Confirm?"

If the user agrees, mark the dimension green and cite the proposal as the
answer. If they push back, treat their pushback as the new answer.

#### When the planner realizes "this is two features"

If the interview surfaces that the scope is genuinely two specs (two
separable outcomes, two independent success signals, no shared blast
radius), stop. Recommend splitting:

> "This looks like two features: (a) the events backend, (b) the events
> UI. They share no contracts and ship independently. I'd plan them as two
> specs. Continue with one of them, or stop and re-scope?"

Do not press on and produce an oversized spec to avoid the conversation.

### Handling genuinely unknown answers

Sometimes neither the user nor the codebase can answer a dimension. Distinguish:

- **Product / intent unknown** ("should it be SSO or password?", "should
  empty state show a CTA or stay blank?") — refuse to write. Ambiguity
  should never ship. Keep interviewing or escalate to a decision-maker.
- **Technical unknown** ("will this migration approach scale on the 50M-row
  table?", "does the ORM's bulk-insert support our type?") — make the
  first brief a **spike**: a research/exploration brief whose ACs are
  "produce a finding, commit it as a handover, gate the rest of the series
  on the finding." Subsequent briefs depend on it.

Ask explicitly when unsure: "is this a product unknown or a technical
unknown?"

### Exit test — the show-back

The show-back is what the user actually reads before greenlighting. A
markdown wall in the terminal invites skim-and-skip; an HTML interface
invites click-and-engage. Render it as HTML.

Process:

1. Assess coverage internally (every dimension + every brief).
2. Render a single self-contained HTML file the user opens in a browser.
3. Print one line to the terminal pointing at the file.
4. Wait for `green light` in the terminal before writing any spec output.

#### 1. Coverage assessment (internal)

Walk all 15 dimensions and classify each:

- ✅ Answered by the user (quote their answer, cite which question)
- 📂 Answered by the codebase (cite the file(s) and what they told you)
- 📋 Answered by a fact or ADR (cite `fact-NNN` or `ADR-NNN`)
- ⚠️ Explicitly marked N/A with a one-line justification (e.g.
  "UX flows: N/A — feature is internal API only, no user-facing surface")

For every brief you're about to write, confirm you can name:

- The exact files it touches (the `touches` list)
- The files it must NOT touch (the `does_not_touch` list — both lists
  are advisory; reviewer adjudicates deviations)
- The interfaces it must respect (cite the contract section in design.md)
- The ACs it must satisfy — every AC must be `type: api` or `type: web`
  and actually fire in the validation engine. Build + tests run
  automatically via the pipeline; do NOT list them as ACs. If no
  `api`/`web` check is possible for a brief, write zero ACs and lean on
  Test expectations + the diff reviewer for anchoring.
- The dependency graph, without guessing

For web-facing features, confirm that every new or significantly rearranged
screen has an approved wireframe from the interview loop. No wireframe = red.
A wireframe produced at write-time (not during the loop) = red. A wireframe
that the user hasn't explicitly signed off on = amber.

Verify the **outcome → AC link with type discipline**:
- "visible" / "renders" / "user sees" → linked AC must be `type: web`
- "endpoint returns" / "responds" / "stores" → `type: api` (or `web`)
- "symbol removed" / "file exists" / "flag flipped" → `type: cmd`

Cite which brief's AC validates the success signal in `purpose.md`. If
the AC type doesn't match the outcome verb, the loop is not done — fix
the AC type, or re-frame the outcome to match what you can actually
validate. A `cmd` AC linked to a "visible" outcome is theatre.

#### 2. Render the show-back as HTML

Write a single self-contained HTML file to:

```
.autopod/review/exit-checklist.html
```

Create the `.autopod/review/` directory if it doesn't exist. The path
is gitignored — this is a transient review surface, not a deliverable.
Overwrite the file on every regeneration.

A reference implementation lives at
`.autopod/review/SAMPLE-proof-of-work-screenshots.html`. Read it before
generating; match its layout, color semantics, and interaction model.
Do not copy it byte-for-byte — re-derive from the spec under review —
but the structural shape should be recognisably the same.

**Self-contained constraints (non-negotiable):**

- One file. Inline `<style>` and `<script>`. No CDN, no external fonts,
  no external images, no `<link rel="stylesheet">`.
- System font stack only:
  `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif`.
  Monospace via `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- Dark theme. Reasonable contrast. No light-mode toggle — keep it small.
- Must render correctly when opened directly via `file://` with no
  network connection.

**Layout:** header bar across the top, then a two-column body. Brief
grid on the left (≈70%), sticky attention rail on the right (≈360px).
Collapse to single column under ~1040px viewport.

**Header:**

- Title: `Plan preview — <feature-name>`.
- Summary line: brief count, gate count (note any parallel groups),
  ADR-introduced count, the one-line outcome from `purpose.md`.
- Filter buttons: `Show only briefs with issues`, `Expand all`,
  `Collapse all`.

**Brief grid (left column):**

- Group briefs by gate. A *gate* is a set of briefs at the same
  dependency depth that may run concurrently. Render each gate as a
  panel with a label like `Gate 2 · parallel · 3 briefs depend on 01`.
  **Stack briefs vertically inside a gate — never render parallel
  siblings as side-by-side columns.** Brief bodies are dense (Task
  paragraph, Touches with full paths, AC groups, Full draft markdown)
  and column layouts force line-wrap-per-word; the `<pre>` for the
  draft markdown is unreadable below ~600px. The `parallel` signal
  lives in the gate label, not in the column layout. Render an `↓`
  arrow between gates to show sequential dependency.
- Each brief is a `<details>` element (HTML's native collapsible) with
  a colored left-border halo:
  - **green** — clean: no open question, no theatre risk.
  - **amber** — has at least one open question or AC theatre risk.
  - **red** — has an unresolved blocking issue.
- Brief summary (always visible): name, file count, AC-count breakdown
  (e.g. "3 api · 1 cmd"), `depends_on` chip, halo count badge.
- Brief expanded body, in this order:
  - Task — one paragraph (verbatim or paraphrased from the brief's
    `## Task` section).
  - Touches — file list; mark new files with a "new" badge.
  - Acceptance criteria — **grouped** into:
    - *Validates outcome* (api/web ACs that fire on the user-visible
      outcome named by the success signal).
    - *Corroborates wiring* (cmd ACs that catch structural regressions).
    - *AC theatre risk* (any AC whose type mismatches its outcome verb,
      or whose pass condition would still hold on a broken feature).
  - Success-signal link — explicit
    `success signal #N ←→ AC #M (type)` line with a ✓ or ⚠ verdict on
    type-match.
  - Broken-feature mirror — one-sentence answer to "would all ACs still
    pass on a broken feature?" with ✓ or ⚠.
  - Per-brief issues (if any) — each rendered as an inline callout with
    a label, body, and 2–3 selectable resolution choices
    (e.g. `split as proposed`, `keep`, `counter-propose`). Choices are
    rendered as pill-shaped buttons (NOT link-styled) and behave like a
    radio group: clicking one selects it and de-selects the others for
    that issue. The selected pill is filled with the accent color;
    unselected pills are outlined and muted. Selection state feeds the
    reply composer (see Interactivity).
  - Full draft markdown — a collapsed `<details>` revealing the
    complete `briefs/NN-*.md` content as it will be written, including
    YAML frontmatter and every body section (Task, Touches, Does not
    touch, Constraints, Test expectations, Wrap-up). Summary line shows
    the destination path
    (e.g. `specs/<feature>/briefs/02-expose-screenshots-api.md`) so the
    user can see exactly where the file lands. Inside the panel, a
    `Copy draft` button writes the `<pre>` contents to the clipboard
    via `navigator.clipboard.writeText(...)`. On `file://` browsers
    that block the clipboard API, fall back to selecting the `<pre>`
    contents with `Range` + `Selection` so the user can hit `cmd+c`.
    Render in a monospaced `<pre>` with `max-height: 480px` +
    `overflow: auto` so a long brief doesn't blow out the card.
    Briefs are not on disk yet at this stage — this panel is the
    user's only way to read the actual contract before greenlight.
    The structured panels above remain the primary review surface;
    the raw draft is for verification, not for replacing review.

**Side rail (right column, sticky):**

Order top-down by attention priority:

- `Wireframes (N)` *(only when at least one screen is new or rearranged)* —
  One `<details>` per affected screen. Summary line: screen name + approval
  status chip (Approved / Needs revision / Pending). Body: the ASCII wireframe
  in a `<pre>` block with `font-family: ui-monospace` and a light border.
  Below the wireframe, two resolution pills (radio-group semantics):
  `Approved as-is` and `Needs revision`. Default state: neither selected
  (Pending). When `Needs revision` is selected, a small inline textarea
  appears for the user to note what to change — its value is included in
  the reply composer output. A feature whose any wireframe is Pending or
  Needs revision must surface as a cross-cutting issue blocking greenlight.
  Auto-expand the first wireframe `<details>`; collapse the rest.

- `Cross-cutting issues (N)` — issues that aren't bound to a single
  brief: success-signal-not-linked, parallel-touch conflicts on shared
  files, deferred user answers, unverified precedents. Each issue has
  a heading, a paragraph of context, and 2–3 selectable resolution
  choices using the same pill / radio-group treatment as per-brief
  issues (see above). Below the listed issues, a one-line
  `…plus N issues across M briefs` with a button that activates the
  `Show only briefs with issues` filter.
- `ADRs introduced (N)` — each ADR rendered as a `<details>` with the
  ID and Accepted/Proposed status in the summary. Body sections:
  Decision, Consequences (split into Easier `+` / Harder `−` /
  Committed-to `⚙`), Alternatives rejected. Source path at the bottom.
  Auto-expand the first ADR; collapse the rest.
- `ADRs reused (N)` — each row shows ID, title, and the file path
  (`docs/decisions/ADR-NNN-*.md`) in mono on a second line. Path text
  is `user-select: all` so a single click selects it for copy-paste.
  Rows are NOT styled as hyperlinks — `file://` browsers refuse
  cross-protocol links anyway, and `cmd+click` in supported terminals
  works on plain monospace paths. Empty-state ("No prior ADRs constrain
  this spec.") is fine.
- `Source material (N)` — the markdown the planner actually read while
  filling out coverage. Three collapsible subsections, each a `<details>`:
  - `📋 Facts cited` — every `fact-NNN` referenced during the loop.
    Row = id + title + path (`docs/facts/fact-NNN-*.md`). Open by
    default.
  - `📚 Reference reading` — CLAUDE.md sections, READMEs, and code
    pointers captured during the opening scan (dimension #12). Row =
    title + path. Collapsed by default.
  - `🧩 Skills the executor will invoke` — local `.claude/skills/*`
    skills that any brief expects the agent to run. Row = title + path.
    Collapsed by default. Omit the subsection entirely if zero skills
    are cited.
  Lead the panel with a one-line hint: "Markdown the planner read while
  filling out coverage. Paths are selectable — copy into your editor to
  verify." Skip the panel entirely if all three subsections would be
  empty.
- `Coverage` — counts by status (covered / amber / red), ADR counts,
  brief counts (clean / open question / red). One-line source summary
  at the bottom (e.g. "11 dims by codebase scan, 3 by user answer, 1
  by precedent").

**Color semantics** — use consistently for borders, badges, bullets,
and section headings:

- green: dimension covered, AC validates outcome, ADR consequence
  "easier"
- blue: api ACs, selected resolution pills (filled), reply-composer accent
- amber: open question, AC corroborates wiring, deferred answer
- red: unresolved/blocking, AC theatre risk, ADR consequence "harder"
- accent (purple/violet): ADRs, accepted decisions

Resolution pills must NOT be styled as hyperlinks (no `<a>` underline,
no dashed border that mimics a link). Use a true button affordance:
rounded rectangle, subtle border in the unselected state, filled with
the blue accent when selected.

**Interactivity** — vanilla JS, no framework, ~80 lines:

- `Expand all` / `Collapse all` toggle `open` on every
  `details.brief, details.adr`.
- `Show only briefs with issues` toggles a `.hidden` class on briefs
  without a halo and auto-expands the visible ones. Button label
  swaps between `Show only briefs with issues` and `Show all briefs`.
- **Resolution pill selection** — clicking a pill toggles a
  `.selected` class on the clicked pill and removes it from the other
  pills inside the same `.actions` container (radio-group semantics
  per issue). State lives in DOM only; no persistence.
- **Reply composer** — this is the load-bearing review surface. The
  whole point of the rich show-back is that the reviewer's pill
  selections survive into the reply. A static instruction panel
  (`Type one of: green light / redo X / push back …`) is **not** a
  reply composer — it has no DOM link to the pills, so every
  resolution the reviewer just clicked gets dropped on the floor.
  Treat it as a bug if your generated HTML reaches the user without
  the markup below.

  **MUST render** — the panel MUST be a `<details class="reply-composer"
  data-composer="reply">` element containing all four:

  1. A `<summary>` showing `Reply composer · N/M selected`, where `N`
     and `M` are live-updated by the interactivity script.
  2. A `<textarea class="reply-text">` whose value is rebuilt from
     the selected pills every time selection changes, following the
     Reply template below verbatim.
  3. A `<button class="copy-reply">Copy reply</button>` that calls
     `navigator.clipboard.writeText(textarea.value)` on click.
  4. A `<div class="reply-toast" hidden>` for the success toast.

  Lives **inside the side rail as its last panel**, NOT as a
  `position: fixed` floating overlay. The rail is already
  `position: sticky; top: 24px; max-height: calc(100vh - 48px);
  overflow: auto;` so the composer at the rail's bottom stays
  visible as the user scrolls and never floats over the brief grid
  or the Coverage list. Use `position: sticky; bottom: 0` on the
  composer's outer element so it stays anchored to the rail's
  visible bottom even when the rail's internal content scrolls past
  it. Default `open` state: closed when `N == 0`, opens
  automatically when the first pill is selected. This is the
  "collapse-when-empty" behavior — a reviewer scanning the plan
  never has the composer's full body eating rail space until they
  actually start resolving an issue. `M` is the total count of
  issues (per-brief + cross-cutting); `N` updates live as pills are
  selected. The `Copy reply` button is disabled while `N == 0` (the
  user can still type `green light` in the terminal directly). Show
  a brief inline toast (`Copied — paste into your terminal`) on
  success; fall back to making the `<textarea>` selected and
  instructing the user to `cmd+c` if the clipboard API is
  unavailable (some `file://` browsers refuse it).

**Reply template** — the assembled clipboard text MUST follow this
exact shape so the planner can parse it deterministically:

```
Resolutions for plan preview:

- <issue-label>: <selected-pill-text>
- <issue-label>: <selected-pill-text>
...

Unresolved (no selection): <issue-label>, <issue-label>
```

Omit the `Unresolved` line entirely when every issue has a selection.
Issue labels match the heading rendered in the callout — no
abbreviation, no reformatting. The user can edit the text after
pasting; the structure exists to make the common case (accept all
defaults) one keystroke.

**Self-check before declaring the show-back done.** After writing
`.autopod/review/exit-checklist.html`, grep the file and verify all
four markers are present. If any is missing, the show-back is
broken — fix the markup and rewrite the file before printing the
path:

```bash
grep -c 'class="reply-composer"' .autopod/review/exit-checklist.html  # must be ≥ 1
grep -c 'class="reply-text"'     .autopod/review/exit-checklist.html  # must be ≥ 1
grep -c 'class="copy-reply"'     .autopod/review/exit-checklist.html  # must be ≥ 1
grep -c 'data-composer="reply"'  .autopod/review/exit-checklist.html  # must be ≥ 1
```

If any of those return `0`, you wrote a static instruction panel
instead of the composer. Regenerate before continuing.

#### 3. Print the path and ask for greenlight

After writing the file, print exactly one short message to the terminal:

```
✅ Show-back rendered: .autopod/review/exit-checklist.html

Open it in a browser, work through every halo and rail item. For each
open issue, click one of the resolution pills. When you're done, hit
"Copy reply" in the bottom-right and paste it back here — or just
reply "green light" if you have no resolutions to send.
```

Do NOT print the markdown checklist alongside it. The HTML is the
review surface; printing the markdown defeats the point. Do NOT start
writing the spec until the user replies `green light` (or an
equivalent affirmation).

If the user pushes back on any AC or spots a gap, treat that as a
re-opened dimension and keep interviewing — do not negotiate the AC
away. The ACs are the contract between the planner and the validation
engine; getting them wrong means a green pipeline on a broken feature.
After re-interviewing, regenerate the HTML show-back at the same path
(overwrite). Each iteration should produce fewer halos.

---

## Output structure

```
specs/<feature-name>/
├── purpose.md       ← why, who, success signal, non-goals, glossary, reversibility
├── design.md        ← seams, contracts, UX flows, file map, reference reading, decisions list
├── briefs/
│   ├── 01-<verb>-<noun>.md
│   ├── 02-<verb>-<noun>.md
│   └── ...
└── handovers/       ← runtime artifact; pods write here, not /plan-feature

docs/decisions/      ← REPO-LEVEL, one file per ADR, numbered globally
├── ADR-001-<slug>.md
├── ADR-002-<slug>.md
└── ADR-NNN-<slug>.md
```

Run order: `ap series create specs/<feature-name>/` (or
`ap series create specs/<feature-name>/briefs/` — both work).

Both `purpose.md` and `design.md` are auto-loaded by the daemon and
rendered as `## Purpose` and `## Design` sections in every pod's CLAUDE.md.
Briefs do NOT need to list them via `context_files` — they're injected.

### purpose.md

Written for the agent (re-read every brief) and the future reviewer.
Daemon takes it verbatim as the PR "Why" section.

Required sections, in order:

```markdown
# <Feature name>

## Problem
One paragraph. The thing that is broken or missing today.

## Outcome
One sentence. The observable change after this feature ships.

## Users
Who is affected; who benefits. Useful when an agent has to pick between
two reasonable behaviours.

## Success signal
How we'll know it worked. Must be observable (a metric, a log line, a
screenshot, a user action succeeding). State the observable only —
**do not pre-bake the validation method.** "Total row visible in
Resource Planner with correct per-period totals" is right; "validated
by file existing, query key wired, unit tests" is wrong (that's already
the AC's job, and it traps the planner into structural-only ACs that
pass on a broken feature). The AC owns the validation method; the
success signal owns the observable. At least one brief AC must validate
this with a matching type — see exit-checklist type discipline.

## Non-goals
- Explicit fence item 1
- Explicit fence item 2
- ...

## Glossary
- **<Term>** — definition. Every noun in the feature description that two
  readers might interpret differently.

## Reversibility    ← OMIT this section when fully reversible
What back-out looks like if this lands and is wrong. Required when the
feature includes a hard-to-reverse change (DB migration, public API change,
on-disk format change, deletion of existing behavior).
```

Keep purpose.md tight — it's read by every brief-executing agent on every
pod. Density matters for THEIR reading load, not because of any PR-body
character limit.

### design.md

Written for the agent and the reviewer. Engineering reference.

Required sections, in order:

```markdown
# Design — <Feature name>

## Blast radius
Files / modules touched, with paths. The agent does not have to re-derive
this. Group by module if that aids reading.

## Seams
Where does one pod hand off to the next? Each seam is a brief boundary.
Name the seam, name the contract that crosses it, name which brief owns
each side.

## Contracts
Types, interfaces, API shapes, DB columns that more than one brief
produces or consumes. Owner per contract.

```ts
// Example contract block — copy what the agent will need to honor.
export interface PodEvent {
  podId: string;
  ts: string;
  kind: 'started' | 'finished' | 'failed';
}
```

## UX flows    ← OMIT when feature has no user-facing surface
Entrypoint → states → exits. Loading / empty / error states. Component list
if a new screen. One short flow per surface.

For each new screen or significantly rearranged surface, include the ASCII
wireframe approved during the planning loop. Example:

```
┌──────────────────────────────────────────┐
│  Nav bar                                 │
├────────────┬─────────────────────────────┤
│  Sidebar   │  Panel title                │
│  item 1    │  ┌──────────────────────┐  │
│  item 2 ●  │  │  Content area        │  │
│            │  └──────────────────────┘  │
└────────────┴─────────────────────────────┘
```

The wireframe here is the approved contract for layout; the flow prose
above it is the state/transition contract. Both are required for new screens.

## Reference reading
Pointers into existing docs and code patterns the executor should consult
before starting. Captured during the planning scan, not regenerated at
write time. Each entry is a path + one line on why it matters.

- `packages/daemon/src/pods/event-bus.ts:42` — existing SSE plumbing this
  feature reuses.
- `docs/decisions/ADR-019-events-hmac.md` — events are HMAC-signed; new
  events must respect this.
- `CLAUDE.md` "Pod Lifecycle" section — state machine the new state
  transitions must fit into.

## Decisions
ADRs introduced or relied on by this feature. List IDs only — full text
lives in `docs/decisions/`.

- ADR-042: Use SSE not WebSockets for event stream (introduced)
- ADR-019: All events HMAC-signed (existing — events repo must respect)
```

### Repo-level `docs/decisions/`

ADRs are durable repo-wide artifacts. They live at `docs/decisions/` (or
`decisions/` / `docs/adrs/` — auto-detect the existing convention; default
to `docs/decisions/` when none exists). Numbered globally across the
codebase. Format:

```markdown
# ADR-NNN: <Title>

## Status
Proposed | Accepted | Superseded by ADR-MMM

## Context
What is the problem? What constraints exist?

## Decision
What we decided.

## Consequences
Easier: ...
Harder: ...
Committed to: ...
```

Only write an ADR for hard-to-reverse or surprising decisions — not for
every micro-choice. The existing `docs/decisions/` folder is read in the
opening scan so prior decisions inform every plan.

### briefs/ — per-pod tasks

Filenames: `NN-<verb>-<noun>.md` (e.g. `01-add-events-types.md`,
`02-wire-events-api.md`, `03-render-events-list.md`). Numeric prefix sets
default execution order; same number means the daemon may run them in
parallel.

#### Frontmatter (YAML)

```yaml
---
title: "Add events API endpoints"
depends_on: [01-types]
acceptance_criteria:
  - type: api
    outcome: POST /api/v2/events with a valid body returns 201 with body.id (uuid)
    hint: POST /api/v2/events
  - type: api
    outcome: GET /api/v2/events?since=now returns 200 with body.events array
    hint: GET /api/v2/events?since=now
  - type: web
    outcome: navigating /events and clicking the first row shows a detail panel with the event title
    hint: /events
  - type: cmd
    outcome: no caller still uses the deleted OldEventEmitter symbol
    hint: rg -l 'OldEventEmitter' packages/daemon/src
    polarity: expect-no-output
touches:
  - packages/daemon/src/pods/events-repository.ts
  - packages/daemon/src/db/migrations/    # directory shorthand — anything under here
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
require_sidecars: [dagger]   # only when needed
---
```

A brief that genuinely cannot be validated by `api`, `web`, or `cmd` (e.g.
it only adds a TypeScript interface, only flips a JSON migration flag, or
only edits CLI / desktop code with no inspectable surface) should ship
with **zero** `acceptance_criteria` entries. The Test expectations body
section + the validation pipeline + the diff reviewer do the anchoring
instead. Do not pad the frontmatter with `none`-typed entries — they are
no-ops and create false confidence. And do not stuff the redundant
build/test commands the pipeline already runs into `cmd` either; the
banlist forces those back to `none`.

Field rules:

- `title` — verb-led to match filename convention.
- `depends_on` — filenames or stems of earlier briefs.
- `acceptance_criteria` — every entry must be a real automated check the
  validation engine actually runs. Three types fire:
  - `api` — single HTTP call (or short create-then-read chain) against
    the running container. The harness has no role-impersonation, so an
    endpoint behind `[Authorize]`/`RequiresUserType(<role>)` will 401 —
    don't write `api` ACs for those paths; either point at an
    unauthenticated endpoint that observes the same state, or use a
    `cmd` AC instead.
  - `web` — browser DOM check via `validate_in_browser` (only when the
    profile has a web UI; downgraded to `none` otherwise).
  - `cmd` — narrow shell check inside the container (typically `rg` /
    `grep` / a tiny one-liner) for things `api`/`web` cannot observe:
    a symbol stopped existing, a config flag flipped, a generated file
    exists, a registration line is present. Banlist: `pnpm build`,
    `pnpm test`, `dotnet build`, `dotnet test`, `npm test`, `tsc`,
    `eslint`, `biome`, `cargo build`, `cargo test`, `make` — these are
    force-classified to `none` because the pipeline already runs build
    + tests; restating them is theatre.

  `type: none` exists but is a no-op for pass/fail determination — the
  engine auto-marks it `passed: true` and excludes it from gating
  (`local-validation-engine.ts:1442-1480`). Any banned build/test/lint
  command is force-classified to `none` by `isCommandLikeAc()`
  regardless of declared type.

  When no `api`, `web`, or `cmd` check applies, leave `acceptance_criteria`
  out entirely. ACs are observable behavioural assertions, never "the
  code compiles" (the pipeline checks that anyway) and never "looks
  correct".
- `touches` / `does_not_touch` — **advisory, not enforced**. The reviewer
  flags deviations as discussion items, never as failures. Use directory
  shorthand (path ending in `/`) to mean "anything under this directory".
  Use explicit file paths otherwise — no globs.
- `require_sidecars` — only when a brief needs a specific sidecar.

#### Body

Required sections, in this order:

```markdown
## Task
What to build, in prose. *What*, not *how*.

## Touches
Same paths as the YAML `touches` list — repeat in prose so the agent reads
them in flow. (The YAML version is what the reviewer consumes.)

## Does not touch
Same paths as the YAML `does_not_touch` list — repeat for the same reason.

## Constraints
Patterns and rules from `design.md` this brief must honor. Quote 2–3
lines and link to design.md rather than restating.

## Test expectations
Which test files to add and what each covers, per behaviour (happy path,
edge cases, error paths). Required for any brief that adds new code —
this is the real anchor when the frontmatter has zero `api`/`web` ACs
(which is most briefs, since most code is not behind an HTTP surface
the test harness can probe). Skip only when the brief is pure config /
docs / dependency bumps with no logic to test.
```

Optional sections (include only when they add value):

```markdown
## Checkpoints
Fail-fast spine for larger briefs. Use only when the brief has natural
intermediate gates (e.g. types must compile before logic).

1. Types compile (`pnpm build` passes)
2. Logic implemented, types still compile
3. Tests added, full suite passes

## Risks / pitfalls
Things the planner suspects could go wrong. Migration prefix collisions,
known-fragile modules, race conditions, etc. Cite past landmines from the
codebase scan when relevant.
```

Required wrap-up section, always last:

```markdown
## Wrap-up
Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
```

`/simplify` is process, not an AC — that's why it's a wrap-up step. ACs
remain about observable outcomes only.

#### What briefs should NOT contain

- "Why" → already in `purpose.md` (auto-injected as `## Purpose`).
- Architecture, contracts, UX flows, reference reading → already in
  `design.md` (auto-injected as `## Design`).
- Full ADR text → cite the ADR ID; canonical text lives in
  `docs/decisions/`.
- Other briefs' work → that's what handovers are for.

### handovers/ — runtime, not authored

`/plan-feature` does NOT write any files in `handovers/`. The daemon's
system instructions tell each pod to read its parent(s)' handover files
from `specs/<feature>/handovers/<parentPodId>.md` before starting and to
write its own to `specs/<feature>/handovers/<thisPodId>.md` before
finishing. Filenames are pod-id-keyed, so parallel siblings produce
distinct files and the next pod reads each parent it depends on.

---

## Handover guarantee

When this skill finishes, the output must be complete enough that:

- `ap series create specs/<feature>/` runs with zero clarifying questions.
- Each pod agent executes its brief without asking the user anything.
- A reviewer reading only `purpose.md` plus one brief understands what
  that pod is doing and why.

If any brief would require a human to explain something at runtime, the
loop was not done.

---

## Anti-patterns

- Writing any output before the exit test passes.
- Asking a question the codebase already answers.
- Asking a question already answered by a fact or ADR — check both indexes
  before forming each question; citing a fact costs nothing, asking wastes a turn.
- Loading every ADR or fact in full without consulting the index first — at
  scale this floods context; use the index to pick relevant entries, then
  read only those.
- Batching two questions in one turn.
- Stopping after 2–3 questions on a multi-module feature (e.g. "New
  scheduler UI" answered with "what screens?" + "what component library?"
  and then writing — that's a fail; you haven't pinned entities, state
  shape, interaction model, empty / error / loading states, success
  signal, or seams).
- Accepting vague nouns without pinning them in the glossary.
- Silently letting an earlier coverage dimension decay when a later answer
  contradicts it.
- Silently deciding when the user defers — always propose-and-confirm.
- Producing one oversized spec when the scope is genuinely two specs.
- Skipping the "ready to write — green light?" confirmation.
- Skipping the HTML show-back. The markdown-in-terminal alternative is
  what causes plans to be rubber-stamped — that's the exact failure
  mode the HTML render exists to prevent.
- Printing the markdown checklist alongside the HTML path. The HTML is
  the review surface; printing the markdown back into the terminal
  invites skim-and-skip and defeats the point.
- Linking external CSS / fonts / scripts in the show-back HTML. The
  artifact must work offline, opened directly via `file://`. No CDN,
  no Google Fonts, no Tailwind play-CDN, no Alpine via unpkg.
- Rendering parallel-gate briefs as side-by-side columns
  (`grid-template-columns: 1fr 1fr 1fr`). Brief bodies are too dense
  to read in ~30%-width columns — Task paragraphs wrap every two
  words, Touches paths overflow, and the `<pre>` for the Full draft
  markdown is unreadable. Stack vertically inside the gate panel; the
  gate label already carries the `parallel` signal.
- Rendering the reply composer as a `position: fixed; bottom; right`
  floating overlay. It will sit on top of the lower half of the side
  rail (typically the Coverage panel) and obscure content the user
  needs to read. Live it inside the rail as the last panel, sticky to
  the rail's bottom, collapsed when zero pills are selected.
- Replacing the Reply composer with a static `Type one of:
  green light / redo X / push back on …` text panel — the
  "instruction-block fallback". It looks similar at a glance but has
  no DOM link to the resolution pills above it, so every selection
  the reviewer just clicked is silently discarded when they reply.
  This is the same failure mode as printing the markdown checklist
  back into the terminal: a review surface that doesn't carry the
  reviewer's input forward is theatre. The required markup is
  enumerated in the Reply composer section — `<details
  class="reply-composer" data-composer="reply">` with a
  `.reply-text` textarea and a `.copy-reply` button. Run the
  self-check greps before printing the path.
- Committing `.autopod/review/exit-checklist.html` to the repo. The
  directory is gitignored; it's a transient review artifact, not a
  deliverable. (The `SAMPLE-*.html` reference file is the only
  exception.)
- Substituting the raw "Full draft markdown" panel for the structured
  AC / theatre / success-signal-link panels in a brief card. The
  structured panels are what catch theatre risk; the raw draft is for
  verification, not for replacing review. If you drop the structured
  panels and only render the draft, every theatre check goes silent.
- Writing draft briefs to disk during the loop (e.g. to a transient
  `.autopod/review/briefs-draft/` location) so the user can read them
  before greenlight. Briefs live in the planner's head until greenlight
  — surface their content via the inline "Full draft markdown" panel,
  not via a parallel file tree that has to be cleaned up on iteration.
- Omitting the path on `ADRs reused` rows or on `Source material`
  rows. The whole point of the panel is "show me the file I can open
  to verify." A title without a path is a citation the user can't
  follow.
- Skipping the wireframe for a new screen or significantly rearranged surface.
  The user cannot greenlight layout they haven't seen. The wireframe is a
  blocking gate, not a nice-to-have.
- Producing the wireframe at write-time instead of during the interview loop.
  The wireframe IS a question — it surfaces layout assumptions the user must
  validate before greenlight. A wireframe the user never saw is not approved.
- Asking "what should it look like?" instead of drawing it and asking "does
  this match?" The user can't sign off on a question; they can only sign off
  on a proposal. Show-and-ask, not ask-then-produce.
- Putting wireframes only in briefs. Wireframes belong in design.md → UX flows
  (auto-injected into every pod's context). A brief-local wireframe is invisible
  to parallel pods touching the same surface.
- ACs that require human judgment ("looks good", "feels right").
- Wrapping build / test / lint commands as ACs (`pnpm build`,
  `dotnet test`, `tsc`, `biome`, `cargo build`, `make`) —
  `isCommandLikeAc()` force-classifies them to `none`, which the
  engine auto-passes and excludes from gating. The pipeline already
  runs build + tests as its first phase; listing them as ACs is
  duplication that creates false confidence. Use `cmd` only for
  *narrow* checks the pipeline does not do (e.g. `rg -l 'OldSymbol'`
  must return no matches).
- Padding `acceptance_criteria` with `none`-typed entries when no
  `api`/`web`/`cmd` check applies. Zero ACs + a thorough Test
  expectations section is honest; an all-`none` AC list is theatre.
- Writing an `api` AC against an endpoint behind `[Authorize]` /
  `RequiresUserType(<role>)` — the harness has no role impersonation
  and the request will 401. Either point the AC at an unauthenticated
  endpoint that observes the same state, swap to a `cmd` AC that
  observes the same change a different way (a config flag, a registered
  route, a generated file), or skip the AC for that brief.
- Treating fuzzy claims like "auth migrated to new middleware" or
  "feature X removed" as one AC. They aren't observable. Decompose
  into 2–5 narrow `cmd` / `api` checks (new file exists, old symbol
  has zero refs, new endpoint responds, inventory flag flipped) — or
  drop the AC and rely on Test expectations + reviewer.
- A brief whose `touches` list exceeds 8 files and not splitting it.
- Writing ADRs in `specs/<feature>/decisions/` instead of repo-level
  `docs/decisions/` — they belong in the durable, globally-numbered home.
- Listing `purpose.md` or `design.md` in `context_files` — they're
  auto-injected; doing so is redundant.
- Skipping ADRs for surprising decisions (the next agent will make wrong
  assumptions).
- Mixing "what to build" with "how to build it" in the brief body.
- Forgetting to tie the success signal to a specific brief AC.
- **Pre-baking the validation method into the success signal** ("validated
  by: file existing, query key wired, unit tests"). The success signal
  states the observable; the AC owns the validation. Pre-baking commits
  the planner to whatever method appears in the clause — usually
  structural-only — and traps every downstream brief into theatre ACs.
- **All-`cmd` ACs on a brief that touches user-visible UI in a web-capable
  profile.** Forbidden by the hard rule in dimension #14. At least one
  `web` AC must observe the user-visible outcome; `cmd` checks
  corroborate the wiring but never replace the behavioural check. If
  every AC would still pass on a broken feature, the AC list is wrong.
- **Type mismatch between outcome verb and AC type** — a "visible"
  outcome linked to a `cmd` file-existence AC, an "endpoint returns"
  outcome linked only to a grep. The AC type must match what the outcome
  describes; if it doesn't, fix the AC or re-frame the outcome.

### Red-flag examples (what "not enough questions" looks like)

| User says | Bad (2 questions → write) | Good (keeps drilling) |
|-----------|--------------------------|----------------------|
| "New scheduler UI to match the new scheduler backend" | "What screens?" → "What library?" → write | + which endpoints/types exist? + what entities are scheduled? + list vs calendar view? + create/edit flows? + empty/error/loading states? + where does it live in nav? + reuse existing components or new? + what does "match the backend" mean — 1:1 fields, or curated? + success signal? |
| "Add auth to the admin panel" | "SSO or password?" → "Which routes?" → write | + which identity provider? + session storage? + role model? + logout flow? + redirect behavior? + existing auth middleware to reuse? + tests seam? + success signal? |
| "Refactor the pod manager" | "Split into what?" → "Keep the API?" → write | + what pain are we solving? + which seams are painful today? + what stays stable? + migration strategy? + test coverage before/after? + rollback plan (Reversibility)? + success signal? |

Rule of thumb: if you can summarize the feature in one sentence *after*
the interview and it sounds identical to the user's original prompt, you
didn't interview — you transcribed.

### Red-flag examples (AC theatre)

| Brief | Bad ACs (theatre) | Good ACs (validate the outcome) |
|-------|-------------------|--------------------------------|
| "Wire total row into Resource Planner frontend" (success signal: row visible with correct totals) | 3× `cmd`: `test -f TopTotalRow.tsx`, `grep RESOURCE_PLANNER_TOP_ROW queryKeys.ts`, `grep getResourcePlannerTotalRow ResourcePlannerGrid.tsx` — every check passes if the file exists and is imported, even when the user sees nothing. | 1–2× `web`: navigate to the page, assert the total row renders below the header with one cell per period and matches expected totals. Optional `cmd` to corroborate query-key wiring. |
| "Add status badge to user list" (success signal: badge visible in row) | `cmd: test -f StatusBadge.tsx` + `cmd: grep StatusBadge UserList.tsx` | `web: navigate /users, each row contains a `[data-testid=status-badge]` element with text matching the user's status` |
| "Migrate auth to new middleware" (success signal: protected routes still gated) | only `cmd: test -f NewMw.cs` | `cmd: ! grep -r OldMw Api/` + `api: GET /api/protected without token → 401` + `api: with valid token → 200` (cmd alone proves the file moved, not that auth still works) |

Rule of thumb for ACs: imagine the agent shipped a broken feature. Would
every AC still pass? If yes, the AC list is theatre — rewrite it before
showing the green-light prompt.

---

## Relationship to other skills

| Skill | Output | Use when |
|-------|--------|----------|
| `/prep` | single brief | 1 validation checkpoint, < 2 hrs |
| `/plan-feature` | `specs/<name>/` folder + ADRs in `docs/decisions/` | 2+ checkpoints, 4+ hrs |
| `/exec` | working code | executing a spec suite locally (not via pods) |
| `ap series create` | running pods | executing the spec via autopod |

