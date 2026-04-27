# ADR 001: Reuse existing 'artifact' OutputMode

## Context

`OutputMode = 'pr' | 'artifact' | 'workspace'` in `packages/shared/src/types/actions.ts:97`.
`'artifact'` was added anticipating this use case but never implemented. Adding a new `'research'`
value would be more descriptive but duplicates the concept and abandons existing scaffolding in
`system-instructions-generator.ts` (artifact-mode branches at lines 161-182, 346-358, 500-515).

## Decision

Implement `'artifact'` fully. Do not add `'research'`.

## Consequences

- No type changes needed for OutputMode
- Existing scaffolding in system-instructions-generator is the starting point, not a rewrite
- The CLI command is `ap research` (user-facing name) but internally uses `outputMode: 'artifact'`
- Any future "artifact" use cases (non-research) benefit from the same implementation
