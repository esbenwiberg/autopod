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
- The extended daemon declaration typecheck defaults to a bounded 4 GiB V8 heap
  only for that command. It still checks the full declaration surface. Caller
  `NODE_OPTIONS` are preserved verbatim: if set, include the required heap setting
  there yourself. This is not a global agent/build/test heap override or permission
  to exceed the worker's admitted memory allocation.
- Keep setup, lint, build, test and independent review enabled in the effective
  workflow. Clone a repository-specific workflow rather than changing a shared
  preset to accommodate one repository.
- Native desktop source still needs macOS verification; Linux/Docker unit tests
  cannot establish Swift compilation or desktop rendering.

An isolated Linux Node22 check at 8 GiB reproduced `ERR_WORKER_OUT_OF_MEMORY`
with the default roughly 2 GiB V8 heap, without a cgroup OOM. The unchanged full
command passed with a 4 GiB heap, using about 4.4 GiB container peak memory. This
is a targeted compiler proof, not full profile or provider acceptance; preserve
8 GiB allocation and serialize expensive checks rather than treating heap size
as a memory reservation or removing declaration scope to make a check pass.

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

The reusable repository setup must match its selected source. Foundation and
operator fixtures are distinct setups, even when both have landed on main.
Reinspect current source before changing defaults: a historical absence of
`control-plane/` does not justify replacing a now-valid foundation setup. Preserve
both explicitly without silently changing the branch under an existing task.

Before operator-fixture work:

- The Node22/Node24 PostgreSQL base templates bake Git 2.56.0 into `/usr/local`,
  independently of the distribution Git package. The installer checks the pinned
  upstream archive SHA-256 before compilation and retains HTTP(S) transports.
  Both images run `autopod-check-git` as the non-root worker during the build. It
  proves `git merge-tree --write-tree --merge-base=<oid>` with disposable local
  commits, ignores inherited checkout/index selectors and cleans only its fixture.
  Re-run that check when qualifying the selected environment and fresh containers;
  a version string or one-off installation in a previous pod is not sufficient.
  Automatic background maintenance and auto-GC are disabled by default in these
  worker images: an unowned maintenance process can otherwise mutate `.git` during
  preservation/capture checks. Explicit maintenance remains possible; applications
  that deliberately ignore system config retain responsibility for their own Git
  execution settings. The isolated capability fixture also disables automatic
  maintenance in its private command environment. No preservation assertion is
  weakened or lock file ignored to obtain a pass.
  Other template families retain their distribution Git; do not weaken integration
  assertions to accommodate an older binary.
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
