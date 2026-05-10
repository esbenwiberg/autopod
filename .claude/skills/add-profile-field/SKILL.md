---
name: add-profile-field
description: >
  Walks through every layer that must be touched when adding a new field to the
  `Profile` type — shared types, daemon migration, profile-store, profile-validator,
  6 desktop layers, and CLI exposure. Use when adding any new property to
  `packages/shared/src/types/profile.ts`.
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

# /add-profile-field

Adding a field to `Profile` touches eleven layers. Skip one and you'll ship a
field that the daemon validates but the desktop can't render, or that the CLI
can write but the SQLite store drops on read.

## When to use

- The user says "add a profile field", "new profile property", "profile setting", etc.
- The user starts editing `packages/shared/src/types/profile.ts` to add a property.
- A new feature requires per-profile configuration.

## When NOT to use

- The change is a tweak to an existing field's shape (rename, type narrow) — those
  don't need full layer coverage, just the call sites.
- The setting belongs on `Pod` or another type, not `Profile`.

## Procedure

Work through every step. Check each one off before considering the task done.

### 1. shared — type

Add the field to the `Profile` type in `packages/shared/src/types/profile.ts`.
If the field references a new struct/union, define and export it from
`packages/shared/src/index.ts`.

### 2. daemon — migration

`ALTER TABLE profiles ADD COLUMN ...` in a new
`packages/daemon/src/db/migrations/0NN_*.sql`.

**Never reuse a numeric prefix.** Run
`ls packages/daemon/src/db/migrations/ | tail -5` to see the highest one.
The runner uses the prefix as the schema version — duplicates are silently
skipped. (A `PreToolUse` hook should now block this case locally; CI catches
the cross-branch case.)

### 3. daemon — profile-store

Update three things in `packages/daemon/src/profiles/profile-store.ts`:
- `rowToProfile()` — read the new column
- INSERT statement — include the new column
- UPDATE statement — include the new column

### 4. daemon — profile-validator

Add validation rules in `packages/daemon/src/profiles/profile-validator.ts`.
Zod schema. Whatever invariants the field has, encode them here — defaults,
ranges, enum membership, conditional requirements.

### 5. desktop — API layer

`packages/desktop/Sources/AutopodClient/Types/ProfileResponse.swift`:
- Add the field
- Add any new struct types
- Decode in `init(from decoder:)`

### 6. desktop — UI model

`packages/desktop/Sources/AutopodUI/Models/Profile.swift`:
- Add the field
- Update `init()` to populate it

### 7. desktop — mapper

`packages/desktop/Sources/AutopodDesktop/Mapping/ProfileMapper.swift`:
- Map response → UI model
- Map UI model → patch dict (for PATCH requests)

### 8. desktop — field catalog

Add an entry to `ProfileOverrideCatalog.all` in
`packages/desktop/Sources/AutopodUI/.../ProfileFieldCatalog.swift` so derived
profiles can override the field. Without this, the field is invisible in
derived-profile editors.

### 9. desktop — override card

Add a `case "fieldKey":` branch in `overrideCard(for:)` in
`ProfileEditorView.swift` and implement the card renderer. Without this,
derived-profile editors show a "no editor available" placeholder for your new
field — silent failure mode that's easy to ship.

### 10. desktop — base editor UI

Add controls in the relevant `ProfileEditorView` section (base profile editor).

### 11. CLI

If the field is user-facing, expose it in
`packages/cli/src/commands/profile.ts` (set/get/show subcommands as appropriate).

## Verification

Before marking complete:

```bash
# All four packages still build
npx pnpm build

# Validator tests still green
npx pnpm --filter @autopod/daemon test

# Desktop builds
xcodebuild -project packages/desktop/Autopod.xcodeproj -scheme Autopod \
  -destination 'platform=macOS' -configuration Debug build
```

Grep for the field name across `packages/` to spot-check that no expected
layer is missing it.
