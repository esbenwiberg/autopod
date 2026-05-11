# Design — AC schema v2

## Blast radius

| Layer | File | Change |
|-------|------|--------|
| Shared types | `packages/shared/src/types/ac.ts` | Replace `AcDefinition` shape; add `AcPolarity`. |
| Brief parser | `packages/shared/src/series/parse-briefs.ts` | Read `outcome` / `hint` / `polarity`; throw on legacy keys. |
| DB read path | `packages/daemon/src/pods/pod-repository.ts:206` | Throw on legacy JSON shape; null-protect via wrap-up. |
| Validation engine | `packages/daemon/src/validation/local-validation-engine.ts:1131-1297, 1563-1622, 1953-2023` | Tighten regex; trust declared types; thread `ac.hint`; read `ac.polarity` directly. |
| Desktop client types | `packages/desktop/Sources/AutopodClient/Types/AcDefinition.swift` | Mirror v2 shape in Swift. |
| Desktop form | `packages/desktop/Sources/AutopodUI/Views/Creation/CreatePodSheet.swift:545-594` | Stacked outcome + hint + polarity rows. |
| Desktop detail | `packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift:688, 1037-1048` | Two-line render (outcome + hint subtitle); regex mirror update. |
| Spec corpus | `specs/**/*.md` (15 briefs in 8 specs) | Mechanical migration. |
| Plan-feature skill | `.claude/skills/plan-feature/SKILL.md` | Teach the new shape in the AC example block. |

## Seams + briefs/ ordering

```
Gate 1 (root)
└─ 01-update-ac-schema           (shared types + parser + Swift mirror)

Gate 2 (parallel, all depend on 01)
├─ 02-migrate-existing-briefs    (specs/** mechanical rewrite)
├─ 03-update-validation-engine   (daemon classifier + executor + LLM prompt)
├─ 04-update-desktop-form-and-tab (macOS UI)
└─ 05-update-plan-feature-skill  (.claude/skills/plan-feature/SKILL.md)
```

Brief 01 is the contract publisher; everything else consumes it. The Gate 2
briefs are independent — they touch disjoint files. They can run as a
parallel pod batch.

## Contracts

### `AcDefinition` (TypeScript, owner: brief 01)

```ts
export type AcType = 'none' | 'api' | 'web' | 'cmd';
export type AcPolarity = 'expect-output' | 'expect-no-output' | 'exit-zero';

export interface AcDefinition {
  type: AcType;
  outcome: string;          // required, ≤200 chars — was `test`
  hint?: string;            // optional, ≤500 chars — URL / selector / endpoint / cmd
  polarity?: AcPolarity;    // only valid when type === 'cmd'
}
```

Type-narrowing: TypeScript should reject `polarity` on non-`cmd` types via a
discriminated-union refinement (`{ type: 'cmd'; polarity?: AcPolarity }` vs
`{ type: 'api' | 'web' | 'none' }`).

### YAML frontmatter shape (owner: brief 01, consumer: brief 02, 03, 05)

```yaml
acceptance_criteria:
  - type: web
    outcome: /pr-dashboard renders with the header bar
    hint: /pr-dashboard
  - type: api
    outcome: POST /pods returns 201 with body.id
    hint: POST /api/pods
  - type: cmd
    outcome: legacy keys removed from shared types
    hint: grep -n 'pass:\|fail:' packages/shared/src/types/ac.ts
    polarity: expect-no-output
```

The YAML keys are `outcome`, `hint`, `polarity` — verbatim. No aliases. The
parser must reject `test:`, `pass:`, `fail:` with a line-number error.

### Swift mirror (owner: brief 01)

```swift
struct AcDefinition: Codable, Equatable {
    enum AcType: String, Codable { case none, api, web, cmd }
    enum AcPolarity: String, Codable {
        case expectOutput = "expect-output"
        case expectNoOutput = "expect-no-output"
        case exitZero = "exit-zero"
    }
    let type: AcType
    let outcome: String
    let hint: String?
    let polarity: AcPolarity?
}
```

### DB JSON blob (owner: brief 01, consumer: brief 03)

`pods.acceptance_criteria` is a TEXT column holding a JSON array of
`AcDefinition` records. Brief 01's `parseAcceptanceCriteria` reader throws on
any record missing `outcome` (i.e. legacy shape with `test:`).

## UX flows

### Create-pod sheet (brief 04)

Per AC row in the criterion editor:

```
┌───────────────────────────────────────────────┐
│ Type: [ web ▾ ]                       [ × ]   │
│                                                │
│ Outcome                                        │
│ ┌──────────────────────────────────────────┐  │
│ │ /pr-dashboard renders with the header    │  │
│ └──────────────────────────────────────────┘  │
│                                                │
│ Hint  (Page path or selector — e.g. /pr-dash) │
│ ┌──────────────────────────────────────────┐  │
│ │ /pr-dashboard                            │  │
│ └──────────────────────────────────────────┘  │
└───────────────────────────────────────────────┘
```

When `type == .cmd`, a third row appears with a Picker bound to
`polarity` (`exit-zero` is the default). When `type == .none`, the hint row
collapses (decorative ACs don't need a hint).

### Validation tab (brief 04)

The AC card subtitle changes from a single `Text(criterion.test)` line to
`Text(criterion.outcome).font(.body)` plus, when present, a smaller
`Text(criterion.hint).font(.caption).foregroundStyle(.secondary)`.

## Reference reading

- `packages/daemon/CLAUDE.md` — daemon subsystem map; pod-manager / validation
  sections are most relevant.
- `CLAUDE.md` (root) — the AC story is currently undocumented in the root
  guide; brief 03 should add a one-paragraph note under "Validation Engine".
- `docs/decisions/index.md` — list of prior ADRs; **no prior ADR governs AC
  schema**, so ADR-024 is greenfield.
- `packages/desktop/Sources/AutopodUI/Views/Creation/CreatePodSheet.swift:545-594`
  — current criterionRow source; read before redesigning.
- `packages/daemon/src/validation/local-validation-engine.ts:1131-1297` —
  classifyAcTypes; the heart of the bug.
- Bug exemplar: pod `confidential-loon`, two `/pr-dashboard` ACs marked
  `decorative · web · none`. Use as the regression test case in brief 03.

## Cross-cutting decisions captured

- **In-flight pods at cutover** (`null-ok`): the wrap-up SQL one-liner nulls
  legacy-shape `pods.acceptance_criteria` rows. Accepted risk — pods
  currently running will lose their AC results on next read. Drain the
  queue before merging Gate 2 if you want to be safe.
- **Brief 03's outcome AC is `type: api`** (`keep-api`): a round-trip
  create-pod assertion. The integration harness is expected to support
  `POST /pods` create-then-read. If that turns out to be wrong during
  execution, escalate via `report_blocker` and convert to a vitest
  integration test.
- **Frontmatter rename** (`a-rename`): the YAML key is `outcome:`, not
  `test:`. No alias. Muscle memory dies on the first parse error.
