# Final validation toolchain environment (#480)

## Symptom and evidence boundary

In xPM Vibe's frozen launch, configured self-validation selected pinned Node24,
while final validation selected the image's Node22 and failed the same setup
assertion. The incident establishes different executable selection, but does not
capture the final child environment or prove where it was lost.

At baseline `8e45a525`, native self-validation uses buffered exec, which embeds
its environment in the command. Final sandbox setup/build/test use streaming
exec. That transport stages argv in a readable wrapper and separately sends
`start.environment`; the ordinary wrapper also switches root-started processes
to the runtime user. Source inspection alone does not prove that the live server
or user switch dropped the environment.

## Bounded hardening

Final-validation and revalidation inputs copy the admitted launch's **literal**
build environment separately from resolved execution credentials.
`resolveLaunchExecutionSettings` already excludes credential references from
that projection. Legacy profiles have no such distinction and keep their
existing environment-only path.

Configured setup/build/test/lint/SAST/fact commands reapply those literals using
`/usr/bin/env --` inside the child argv, after transport/user wrappers. A literal
is included only when it matches the resolved execution environment, preserving
daemon-owned context overrides. Arguments remain individually quoted by the
existing adapter. Credential values are not copied into the readable staged
script; the scoped exec environment and secret-file shim remain intact.

This is defensive hardening, not a proven live Azure fix. It does not recover
lost secret transport, change tool versions, replace frozen settings, or alter
checkpoint/custody, process ownership, retry, review or delivery gates. There are
no new dependencies, migrations, image/profile changes or diagnostic env dumps.
The Node24 standard environments from #486 are independent; they do not change
already-frozen launches. Open #478 overlaps input/revalidation assembly: retain
both its checkpoint transport changes and this literal projection when integrating.

## Regression scope

The Linux-only adapter regression executes the actual staged wrapper, through
engine → routing manager → sandbox manager → Azure adapter, in real non-login
child shells. Synthetic executables model image and explicitly selected tools.
The fixture deliberately discards the streaming environment frame: native
setup/build/test pass, final setup fails without hardening, and final
setup/build/test plus repeated validation pass with hardening. Wrong/missing
selection still fails setup and prevents later streamed phases. This fault
injection does **not** establish live service behavior.

The wrapper uses Linux `/proc`; this regression is skipped on macOS, not
rewritten to fake process ownership. A portable real-shell test separately checks
literal metacharacter handling. Existing real-Git checkpoint tests verify selected
tools after reset and forbid any exec for unowned checkpoints. Engine-owned reset,
permission and staging operations in the adapter fixture are acknowledged rather
than run against the checkout. Root-to-runtime-user switching and live Azure
acceptance are not qualified by these tests.

## Local implementation and operator acceptance

The owner explicitly selected local implementation after repair worker
`available-mollusk` became blocked on an unverified test execution. Its observed
committed patch was used as an independently inspected candidate on current main,
not as proof of that execution's final source or reports. Local checks and normal
PR review do not settle the historical run. Preserve its original resources.

After review/merge and **separately authorised deployment**, qualify a safe fixture
sandbox with the deployed binary, real buffered/streaming transports and pinned
tool selection, including post-checkpoint execution. Inspect only non-secret tool
resolution/version and environment-key presence, never credentials. Then inspect
the xPM Vibe task's current source, frozen identity, execution evidence and retry
eligibility before authorising fresh validation. Require setup, build, tests,
facts and conclusive native final review; do not infer acceptance from these local
fixtures or waive checks.

For unknown executions, follow [validation execution recovery](validation-execution-recovery.md)
and [retained checkpoint recovery](retained-checkpoint-recovery.md). Do not Resume,
kill, delete, override or repeat a blocked execution without the required evidence.
