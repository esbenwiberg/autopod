# ADR-029: Validation setup is a first-class blocking phase

## Status

Proposed

## Context

Some profiles need to install validation tooling before lint, SAST, build, or
tests can run. The Guardian profile exposed this when lint ran first and failed
with `ruff: not found`, even though the later build phase installed `ruff`,
`mypy`, and `semgrep`.

There are two tempting implementation shapes:

- hide setup as an internal pre-step before validation starts; or
- model setup as a normal validation phase with visible status, output, and
  skip behavior.

The hidden shape would make the pipeline easier to keep visually unchanged, but
it would also hide exactly the failure users need to diagnose: dependency/tooling
setup. It would also leave `validate_locally` ambiguous, because an agent asking
for lint would not know whether the validation environment had been prepared.

## Decision

Validation setup is a first-class blocking validation phase.

Specifically:

- Profiles gain `validationSetupCommand`.
- Setup runs before lint, SAST, build, tests, health, pages, facts, and review.
- Setup is visible in validation events, stored validation results, and Desktop
  validation UI.
- Failed setup stops downstream phases and makes validation fail.
- Missing or skipped setup is neutral.
- Setup can be included in `skipValidationPhases`.
- Setup reuses `buildTimeout`; no separate setup timeout is introduced.
- Agent `validate_locally` prepends setup before requested phases every time it
  is called, unless setup is missing or skipped.
- Existing profiles are not automatically migrated or rewritten.

## Consequences

Easier:

- Tooling failures are visible where users already inspect validation failures.
- Desktop can show why lint/SAST/build/tests did not run.
- Agent self-validation becomes deterministic: requested phases run after setup
  when setup exists.
- Existing timeout controls remain small.

Harder:

- Every validation phase list must add Setup in a consistent first position.
- Historical validation attempts will not have setup fields, so clients must
  tolerate missing setup data.
- Operators must manually move setup-ish commands out of existing build commands.
- Setup runs every time, so repeated `validate_locally` calls may repeat package
  installation work.

Committed to:

- Visible setup output over hidden pre-validation behavior.
- No setup cache in this feature.
- No automatic profile migration in this feature.
- `buildTimeout` remains the setup timeout until a real need for a separate
  timeout appears.

## Alternatives rejected

- **Hidden pre-step.** This would keep the validation row shorter but make setup
  failures harder to diagnose and harder for agents to reason about.
- **Fold setup into build.** This preserves the current field shape but does not
  help lint or SAST, which run before build today.
- **Run setup only once per pod.** This saves time but introduces hidden state
  into `validate_locally`; repeated calls should be simple and predictable.
- **Add `setupTimeout`.** This adds another profile field before there is a
  proven need. Reusing `buildTimeout` matches the intended operational knob.
