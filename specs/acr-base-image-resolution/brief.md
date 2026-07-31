---
title: "Publish and resolve ACR base images durably"
touches:
  - packages/daemon/src/images/acr-client.ts
  - packages/daemon/src/images/acr-client.test.ts
  - packages/daemon/src/images/dockerfile-generator.ts
  - packages/daemon/src/images/dockerfile-generator.test.ts
  - packages/daemon/src/images/image-builder.ts
  - packages/daemon/src/images/image-builder.test.ts
  - packages/daemon/src/images/image-digests.json
  - scripts/
  - docs/azure-container-apps-sandboxes.md
does_not_touch:
  - packages/shared/src/types/profile.ts
  - packages/daemon/src/profiles/
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/containers/sandbox-container-manager.ts
  - packages/daemon/src/pods/state-machine.ts
  - packages/desktop/
---

## Task

Make ACR-backed warm-image maintenance consume authenticated, ACR-qualified,
digest-pinned Autopod base images, and add an operator utility that can publish
and verify every supported base-image template without hardcoding a registry.

Preserve the existing local-Docker behavior when ACR is absent. Do not publish
images, mutate hosted profiles, deploy the daemon, or force live warm-image
rebuilds from the implementation pod; those remain explicit operator actions
after the code is reviewed.

## Motivation and repository findings

The hosted daemon logged `pull access denied for autopod-node22-pw` while its
startup warm-image maintenance sweep attempted to rebuild stale profiles. The
same error occurred on both releases `2d213ef7` and `ecfc6631`, so it predates
the latest deployment.

Repository and hosted-environment inspection found:

- `packages/daemon/src/images/dockerfile-generator.ts` maps templates to local,
  unqualified names such as `autopod-node22-pw` and emits `:latest` whenever
  the configured digest is null.
- Every template entry in
  `packages/daemon/src/images/image-digests.json` is null. Its comment refers
  to `scripts/update-image-digests.sh`, but that script does not exist.
- `packages/daemon/src/images/image-builder.ts` uses `AcrClient` to publish the
  finished profile warm image, but it does not qualify, authenticate, verify,
  or pre-pull the base image used by the generated Dockerfile.
- `packages/daemon/src/images/acr-client.ts` already supports ACR auth,
  existence checks, tag qualification, pulls, and manifest digest resolution,
  but its image-reference splitting is tag-oriented and must not corrupt
  `repo@sha256:...` references.
- The hosted daemon is configured with
  `ACR_REGISTRY_URL=ewiautopodacr.azurecr.io`. That registry currently contains
  `autopod-node22-pw-pg` but none of the other concrete Autopod base-image
  repositories.
- Hosted warm-image maintenance uses the seven-day stale threshold. The current
  stale set includes `autopod-self`, `pilot`, and `resource-planner`, all using
  `node22-pw`; additional node, Python, Go, and .NET profiles will encounter the
  same failure as they become stale.
- `docs/threat-model.md` claims base images are digest-pinned, so silently
  falling back to a mutable, public-looking `:latest` reference violates the
  documented supply-chain invariant.

## Approved approach

### 1. Make image references digest-aware

Use one image-reference representation/parser for tags and digests in the ACR
client path. A fully qualified reference such as
`registry.azurecr.io/autopod-node22-pw@sha256:...` must retain its repository and
digest through qualification, manifest lookup, and authenticated pull.
Existing tagged-reference behavior must remain compatible.

Do not treat every ACR exception as proof that an image is missing. Resolution
errors must identify the template and qualified base reference and preserve an
actionable cause such as not found, authentication, or registry access.

### 2. Resolve ACR bases before building warm images

When `ImageBuilder` has an `AcrClient`:

1. Derive the concrete base repository from the profile template.
2. Qualify it with the configured ACR registry.
3. Resolve an immutable manifest digest. A non-null checked-in digest may be an
   explicit override; otherwise resolve the configured base tag in ACR at build
   time.
4. Authenticated-pull the exact qualified digest before invoking the Docker
   build so a private base can be consumed without Docker Hub fallback.
5. Generate the warm-image Dockerfile with
   `FROM <registry>/<base>@sha256:<digest>`.
6. Keep the existing `linux/amd64` platform for ACR warm-image builds.

If the base cannot be resolved or pulled, stop before building the profile
image and emit an actionable error containing the profile template and
qualified ACR reference. Never retry the same unqualified name against a public
registry.

When ACR is not configured, preserve current local behavior: generated
Dockerfiles use the local Autopod base name and configured local digest or
`:latest`, no ACR call occurs, and local warm-image tags remain local.

Keep `generateDockerfile()` directly usable by existing callers and tests. A
narrow explicit base-reference override or equivalent injectable resolver is
preferred over reading process environment inside the generator.

### 3. Add a reproducible base-image publication utility

Add a repository-owned operator utility under `scripts/` that:

- accepts a registry argument or `ACR_REGISTRY_URL`; it must not hardcode the
  hosted registry;
- discovers or validates every concrete `templates/base/Dockerfile.*` template
  and maps it to the established root repository name
  `autopod-<template>`;
- builds from the repository root for Linux AMD64 and publishes an immutable
  source-revision tag plus `latest`;
- supports publishing all templates and a selected subset;
- has a side-effect-free dry-run/plan mode suitable for deterministic tests;
- fails if a template is omitted, duplicated, unknown, or mapped to an
  unexpected repository;
- verifies the pushed manifest exists, reports its digest, and rejects an
  incompatible platform before declaring success.

Use a supported ACR or Docker build path rather than embedding hosted
credentials. Document prerequisites and exact invocation. Keep actual
publication behind an explicit operator command.

### 4. Reconcile configuration and documentation

Correct the stale `image-digests.json` comment and related documentation. The
implemented behavior must be honest about which source supplies an immutable
digest:

- explicit checked-in digest when present; or
- ACR manifest resolution at warm-image build time when the entry is null.

Document base publication separately from profile warm-image publication, the
required rollout order, the expected ACR repository names, and diagnostics for
missing or inaccessible bases. Do not weaken the threat-model claim by
accepting mutable ACR tags in the generated `FROM` line.

## Scope boundaries

### In scope

- Digest-safe ACR image-reference handling.
- ACR qualification, digest resolution, authenticated base pull, and immutable
  Dockerfile `FROM` references during profile warm-image builds.
- Preservation of local-only warm-image behavior.
- A general all-template base-image publication and verification utility.
- Focused tests and operator documentation.

### Out of scope

- Profile schema or stored-profile changes.
- Database migrations.
- Changes to sandbox provisioning, network policy, or pod lifecycle.
- Automatic base publication during daemon startup or deployment.
- Automatic mutation of hosted ACR, profiles, or warm images from tests or the
  implementation pod.
- Hardcoding `ewiautopodacr` or any Azure subscription/resource group.
- Disabling or lengthening warm-image maintenance to hide the failure.

## Test expectations

Add focused tests named after the contract scenarios. At minimum prove:

- ACR-backed builds use an authenticated exact-digest pull and the generated
  Dockerfile contains the same fully qualified digest reference.
- Tagged and digest ACR references retain correct repository/version semantics.
- A missing or inaccessible base stops before profile-image build and reports
  the template and qualified reference without public-registry fallback.
- ACR-free builds preserve the existing local `FROM` and local output tag.
- Publication dry-run covers every concrete base Dockerfile exactly once,
  generates Linux-AMD64 publish/verify operations, and performs no Azure or
  Docker mutation.

Run the focused fact commands, all daemon image tests, daemon build/typecheck,
and repository lint. Do not make live Azure publication a test prerequisite.

## Operator rollout after implementation

These steps require separate human approval after review and merge:

1. Run the publication utility in dry-run mode and review the complete plan.
2. Publish all concrete base templates to the hosted ACR, not only
   `node22-pw`, and record the reported digests/platforms.
3. Deploy the daemon fix with the hosted deployment runbook.
4. Force or trigger stale warm-image rebuilds and confirm their
   `warmImageBuiltAt` values advance.
5. Confirm startup/maintenance logs contain no unqualified base-image pull
   failure.
6. Run at least one fresh sandbox pod using a rebuilt warm image and complete
   the existing Azure Sandbox smoke appropriate to the profile.

## Risks and watch-outs

- Pulling a tag and then building from a separately resolved digest can race if
  the tag moves; pull the exact digest or otherwise prove the cached manifest is
  the resolved digest.
- Image parsers that split only on the final colon corrupt digest references
  because `sha256:` also contains a colon.
- ACR auth/network failures must not be mislabeled as a missing repository.
- Publishing every base image is expensive and may take time; dry-run and
  selected-template modes must not reduce all-template coverage.
- Existing warm profile images remain usable during rollout, but stale/missing
  ones remain degraded until both base publication and daemon deployment are
  complete.
- Base templates copy repository files into the image, so publication must use
  the repository root as build context.

## Wrap-up

Before finishing:

1. Run every required fact in `contract.yaml`.
2. Run all tests under `packages/daemon/src/images/` plus daemon build and
   typecheck.
3. Run repository lint and address findings.
4. Run `/simplify` and pre-submit review.
5. Commit and push the implementation, but do not publish images or deploy.
6. Report the exact operator publication command and the post-merge rollout
   evidence still required.
