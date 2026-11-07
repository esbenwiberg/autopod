# Strict execution requirements (opt-in v2)

A task contract can declare worker prerequisites explicitly. This prevents known
incompatible or unverified work from reaching the coding agent; it does not infer
requirements from task prose, provision new authority, or certify validation.
Absent requirements and `version: 1` retain their historical behavior. New fields
are not defaulted into old contracts or frozen launches.

Use `work.contract.executionRequirements` in a composable launch. Contract YAML
uses `execution_requirements` for that outer key; nested names remain camelCase:

```yaml
execution_requirements:
  version: 2
  executables: [node, git]
  minimumMemoryBytes: 2147483648
  minimumCpu: 1
  platform: linux/amd64
  requiredReferenceRepositories:
    - repositoryId: works
      commitSha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

Replace that illustrative commit with the required full lowercase 40- or 64-hex
revision. Supply the same enrolled repository through the launch's existing
`referenceRepositories` selection (`repositoryId`, `ref`, `access: read`). The
daemon resolves the selected ref to an exact commit; a missing or different
revision rejects preview/admission before pod insertion. The daemon stages that
frozen source outside the checkout, without transferring source credentials or
`.git`, using the existing read-only reference snapshot path. A reference snapshot
is source, not an installed CLI or private release artifact.

## Field bounds

The v2 object is strict: unknown fields are rejected. `version: 2` and
`executables` are required. The executable array accepts 0–64 unique names, each
1–256 characters using the existing safe executable-name syntax. Optional fields:

- `minimumMemoryBytes`: positive integer, at most 1 TiB.
- `minimumCpu`: positive number, at most 1024.
- `platform`: `linux/amd64`, `linux/arm64`, `darwin/amd64` or `darwin/arm64`.
- `requiredReferenceRepositories`: at most 16 unique repository IDs, each with
  `repositoryId` (1–128 ASCII letters/digits/underscore/dot/hyphen) and `commitSha`
  (exact lowercase 40- or 64-hex revision). Entry objects are also strict.
- `requiresImageBuild`: only `true` is accepted when present. **Currently rejected
  as an unsupported operation.** Omit it only when the task does not require an
  image build, not as a workaround for a genuine requirement.

## What is checked, and when

Preview/admission compares explicit platform and exact references to the resolved,
frozen configuration. Current worker platforms are Linux, including the `local`
Docker target on a Mac host. Native Darwin worker requirements reject; a Mac host
or an operator capability label does not make a Linux container a Mac worker.
These comparisons do not execute an agent, application build or validation. A
successful preview means static comparison succeeded, **not runtime qualification**.
Changed requirements participate in the launch digest and stale previews reject.
Original-configuration follow-ups are checked as well. An idempotent admitted
request still returns its original receipt, not new proof of runtime readiness.

Immediately before coding/worker validation, the existing execution inspector
probes launchers with bounded, fixed read-only argv and checks actual allocation
metadata. For v2, a missing **or unknown** explicitly declared executable blocks.
Timeouts, malformed/partial output and a missing probe interpreter remain unknown,
not passes. Probe scope limits cannot silently erase explicit dependencies. This
only proves launcher lookup; it does not prove its version, authentication,
application behavior or an external build backend. Inferred launchers/dynamic
shell discovery remain advisory for v2. Actual enabled validation gates still run.
Version 1 retains its existing missing-launcher block and advisory unknowns.

Explicit unknown/insufficient resources block. Unknown image identity/capacity
remains recorded as unknown rather than invented from requested metadata. Strict
platform/reference requirements need frozen composable admission: a legacy pod
without that binding cannot qualify them from ambient worker metadata. Existing
source and attachment staging/delivery checks still apply. The inspector does not
reinterpret declarations as external validation evidence or import private inputs
from local file links.

Worker v2 prerequisites apply to coding and worker validation, not isolated
reviewer/completion phases. Configured review/validation remains unchanged. No
infrastructure hold, unanswered decision, custody/termination check, retry budget
or historical report is cleared by a successful preflight. Continuation retains
its existing lifecycle checks and uses the same inspector before dispatch.

## Deliberate limits

Docker/Podman executable presence, `--version`, `info`, a Docker-capable daemon or
an environment capability label cannot qualify a worker image build. Both static
admission and worker preflight reject `requiresImageBuild: true` until a real
bounded operation qualifier is implemented and authorized. No socket mount,
privileged sidecar, credential grant, automatic reroute or package install is
added to make a requirement pass.

This milestone does not add private binary/release distribution, arbitrary output
path/fallback declarations, artifact-directory write probes, native Mac workers,
external Mac verification import, a generic repair shell, or downgrade safety for
running strict work under an older unaware daemon. Do not downgrade active strict
launches to an unaware daemon. Existing artifact output remains `/workspace`
(`research-output.md` for ordinary artifact research); `/artifacts` is not silently
created or substituted. Required external/Mac checks remain incomplete and still
gate delivery; a declaration or worker-reported deferral cannot pass or waive them.
