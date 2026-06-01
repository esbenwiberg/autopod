# Validation Setup Command

## Problem
Some profiles need validation-time tooling before lint, SAST, build, or tests can
run. The Guardian profile showed the failure mode: lint ran first and failed
with `ruff: not found`, while the later build phase installed `ruff`, `mypy`,
and `semgrep`.

`buildCommand` is currently doing double duty as "install validation tools" and
"build the project", but Autopod's validation order treats lint and SAST as
earlier gates. Agents also use `validate_locally` while working, so the same
missing-tool problem can appear before the full daemon validation pipeline.

## Outcome
Profiles can define `validationSetupCommand`, and Autopod runs it as the first
visible blocking validation phase before downstream checks and before requested
agent self-validation phases.

## Users
- Profile maintainers who need per-repo validation tooling installed in the pod.
- Agents calling `validate_locally` while they work.
- Desktop users reviewing validation status and failure output.
- Operators maintaining profiles such as Guardian that currently overload
  `buildCommand`.

## Success signal
After Guardian moves its tool install command into `validationSetupCommand`,
validation shows `Setup` first. A successful setup allows lint/SAST/build/tests
to run with their tools present, while a failed setup marks Setup red and leaves
downstream validation phases not run.

## Non-goals
- Automatically migrating existing profile commands.
- Rewriting existing `buildCommand` values.
- Caching setup success across validation attempts or `validate_locally` calls.
- Adding a separate setup timeout.
- Hiding setup as an internal daemon-only pre-step.
- Installing global tools outside the profile's configured command.
- Making macOS-only desktop tests required facts for Autopod-self pods.

## Glossary
- **Validation setup** - A profile command run before validation checks to
  prepare tooling or dependencies needed by validation.
- **Setup phase** - The first visible blocking validation phase in Desktop and
  validation events.
- **Downstream phases** - Lint, SAST, build, tests, health, pages, facts, and
  review.
- **Agent self-validation** - The MCP `validate_locally` tool available inside
  agent containers.
- **Skipped setup** - A profile with `skipValidationPhases` containing `setup`;
  setup is not run and does not block downstream phases.

## Reversibility
This feature adds a profile column and optional validation result/event fields.
To back out, keep the column for historical compatibility, stop passing
`validationSetupCommand` into validation, and keep clients tolerant of missing
or historical `setup` result fields. Existing validation records with setup
output remain historical evidence.
