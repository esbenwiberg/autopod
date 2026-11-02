# Worker profile reliability

Profile edits and source fixes solve different failures. A current preset does not
rewrite a frozen launch, resize a retained worker, settle an unknown execution, or
repair a branch. Inspect the effective configuration and recorded outcome first:

```sh
ap run --from-pod <pod> --preview --json
ap execution-provenance <pod> --json
ap status <pod> --json
```

For a new task using today's repository defaults, preview with `--repo` instead of
copying an older pod. Keep actual validation, source custody and delivery evidence
separate from the worker's final prose or terminal pod status.

## Autopod

- Full-repository work uses the Docker (`local`) profile rather than overriding it
  to a sandbox. The sandbox adapter's largest allocation is 4 GiB, even when a
  higher amount is requested. Inspect actual allocation in execution provenance.
- Serialize setup/build/test/typecheck; overlapping installs can race native addon
  compilation, and overlapping checks multiply memory pressure. More container RAM
  alone does not establish adequate declaration-worker heap or passing tests.
- Keep setup, lint, build, test and independent review enabled in the effective
  workflow. Clone a repository-specific workflow rather than changing a shared
  preset to accommodate one repository.
- Native desktop source still needs macOS verification; Linux/Docker unit tests
  cannot establish Swift compilation or desktop rendering.

The streaming self-validation repair is already present in PR #496. See
[validation execution reliability](validation-execution-reliability.md). A daemon
release predating that merge still uses the older implementation; changing a
profile timeout does not deploy the repair. Qualification and deployment are
separate operations, not permission to retry an unobserved command.

## Node certificate trust

Newly built worker base templates set:

```sh
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
```

This extends Node's bundled roots with the image's system-managed CA bundle before
npm/agent installation and at runtime. It does not disable TLS verification,
accept arbitrary certificates, install a proxy CA, or change scoped credentials.
Operators must install any required private CA into the trusted system bundle
through their existing image/platform trust mechanism. A loose certificate file
that has not been incorporated into the bundle is not covered by this setting.
Explicitly configured extra-CA paths remain operator choices.

Published images and frozen digests are unchanged until an image is built,
qualified, published and deliberately selected. Do not infer fleet repair from
source-contract tests. `scripts/worker-ca.test.mjs` exercises actual Node HTTPS
children against local certificate fixtures: managed roots succeed; absent or
unrelated roots and wrong hostnames still fail. Template tests check every worker
family, but do not prove a provider's injected certificates or runtime environment.

## agent-pods-platform

The reusable repository setup must match its selected source. A foundation branch
with `control-plane/` and main's operator fixtures are different setups: preserve
both explicitly rather than assuming an absent directory was deleted or silently
changing the branch under an existing task.

Before operator-fixture work:

- Bake a compatible Git into the reusable environment and prove the actual
  `git merge-tree --write-tree --merge-base=<oid>` operation using disposable local
  commits. A version string or a one-off installation in a previous pod is not
  sufficient. Do not weaken integration assertions for older Git.
- Run the repository's cached-browser prerequisite helper from the selected
  source. The cached Chromium bootstrap repair is already merged in platform
  PR #110; do not replace qualified cached browsers with unconditional downloads.
- Bind preview servers to the assigned `$PORT`. Use a fresh private demo-state
  directory per preview process, and clean up only that owned fixture state.
  Never remove production locks or reuse a manually started demo's state directory.
- Keep Python integration, browser, privacy/security and independent review gates.
  A killed repair pod can still have a subsequently merged PR: verify delivery
  before starting replacement work.

Use the supported configuration CLI's complete replacement payloads and expected
revisions when applying reviewed preset edits. Save the original payloads first,
preview effective launches, and separately qualify the resulting image/toolchain.
No profile edit should waive gates or implicitly resume, merge or deploy a task.
