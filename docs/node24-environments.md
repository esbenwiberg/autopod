# Node24 worker environments: release and migration

This changes new Node worker defaults, not the daemon runtime. Supported Node templates are
`node24`, `node24-pw`, `node24-pw-pg` (PostgreSQL 17), and the intentional compatibility templates
`node22`, `node22-pw`, `node22-pw-pg`. New base profiles, the CLI profile editor seed and desktop
new environment/profile defaults use Node24. Null worker templates and the `custom` fallback
also use Node24; an explicit custom base image still takes precedence. Composable environments
require an explicit template. Derived profile inheritance stays null; PATCH absence stays absent.
Legacy profile import still materializes its historical Node22 fallback. Existing explicit Node22
presets and frozen launch records are not rewritten. Recovery uses the admitted configuration
and image identity; never use a current-settings rerun to stand in for original recovery.

## Worker verification receipt (2026-11-01)

Implementation baseline: `7cea091e91204d59b91cfa92ad759e64b0e7df37`.
The rework worker confirmed the full configured install/native rebuild/build, lint (after
installation), secret scan, seven publication-tool tests, smoke-script shell syntax and diff
whitespace checks. No Docker executable/socket was available; no image build, Chromium or
PostgreSQL execution, publication, desktop execution or live migration is claimed.

Recorded full tests returned no observed result after 307225 ms with
`Buffered sandbox execution result was not observed; reconcile before another execution.`
Host reconciliation is required before replay or successful recorded validation/native review;
this is not a passing test result. Standalone typechecking completed ten tasks before the daemon
declaration worker failed with `ERR_WORKER_OUT_OF_MEMORY`; the same daemon failure reproduced on
the untouched baseline in an isolated worktree using the installed locked dependencies. Dependency
audit failed with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`; TLS verification was not disabled. Resolve
these verification gates on the operator host in addition to the image/backend/Mac gates below.

## Version and image policy

All three Node24 Dockerfiles use upstream `node:24-slim`, including its matching `/usr/local`
headers. This is a maintained major line, not an exact-patch promise. Build the entire family in
one release window, record `process.versions.node` from each smoke, and reject a release with
inconsistent patch versions. Rebuild for security updates; retain tested immutable image digests
and prior artifacts. Agent pins follow the existing base tooling policy. `node24-pw-pg` shares
the existing Node22 initdb wrapper so TCP-only cluster initialization and restart fixes apply to
both. It adds jq and PostgreSQL 17 without a startup Node overlay.

An exact repository assertion such as `process.versions.node === "24.22.1"` is a release gate.
Check the repository's current pin, engines, package manager, native addons and lockfile before
migration. If the tested image does not match, retain the old environment/overlay for that
repository or prepare a separately reviewed exact-version image using matching bundled headers.
Do not advance the assertion or bypass it just to consolidate presets.

## Build, smoke and publication (operator only)

No image publication or live migration is performed by this PR. On a Docker-capable host, from
the reviewed source commit, run `npx pnpm install --frozen-lockfile` to resolve the locked
better-sqlite3 smoke version, then build and smoke each family member before publication:

```bash
for template in node24 node24-pw node24-pw-pg; do
  docker build --platform linux/amd64 -f "templates/base/Dockerfile.$template" \
    -t "autopod-$template:candidate" .
  bash scripts/smoke-node24-images.sh "$template" "autopod-$template:candidate"
done
# Optional exact-patch gate; failure means keep the constrained repository on its old image.
bash scripts/smoke-node24-images.sh node24-pw autopod-node24-pw:candidate 24.22.1
```

The smoke runs as uid 1000 and checks actual Node major/optional exact version, pnpm and agent
executables, trusted Pi worker, a source-built better-sqlite3 addon using local headers, Chromium
launch/page evaluation for browser variants, and PostgreSQL init/start/SQL/stop/restart with
persisted data for the database variant. It installs the repository's existing better-sqlite3
locked dependency version into a disposable directory; registry access is required. No host mounts or credentials
are passed. Capture logs and image IDs. Static/unit tests are not a substitute for these runs.

Use the existing publication tool from a clean committed checkout (its context is `git archive HEAD`):

```bash
node scripts/publish-base-images.mjs --registry "$ACR_REGISTRY_URL" \
  --template node24 --template node24-pw --template node24-pw-pg --dry-run
# Separate explicit operator release action, after candidate smoke approval:
node scripts/publish-base-images.mjs --registry "$ACR_REGISTRY_URL" \
  --template node24 --template node24-pw --template node24-pw-pg
```

This publishes revision and latest tags and verifies matching manifests for linux/amd64. Record
prior latest digests before publication. Re-pull the published revision by digest and repeat the
smoke against those exact artifacts: cloud rebuilds can resolve newer upstream packages. Do not
release on the strength of the candidate run alone. For Azure Sandbox also run the existing
`SANDBOX_IMAGE=<qualified-node24-pw-pg-digest> node scripts/smoke-scruffy-postgres-sandbox.mjs`
from an authorized operator host; see the Sandbox runbook for its Azure settings. Run representative
repository validations through normal launch/review gates on the actual target backend.

Null entries in `image-digests.json` deliberately resolve ACR latest to an immutable digest before
building warm/environment images. Local Docker uses local base tags. Do not fabricate or manually
patch digests. Confirm registry pull permissions and availability for all three names before the
new default is used. Stage image availability before daemon/client rollout; deployment is a
separate operator action. Existing reviewer fallback remains Node22 and is outside this upgrade.

## Inventory and preserve dependencies

On the authorized control-plane CLI, snapshot full documents (including revisions) for environments,
profiles, repositories and all enabled/disabled schedules. Store snapshots privately with restricted
permissions; never commit live IDs, credentials or snapshots. Inspect launch-local overrides,
repository setups, active pods, pending workers and resumable/frozen history as well as profile
references. A zero profile-reference count is insufficient evidence for archival. Keep old digests
and recovery artifacts available for the entire recovery/retention window.

Use `ap preset environment list/show`, `ap profile list/show`, `ap repository list/show` and
`ap schedule list/show` for inventory. Resolve profiles transitively through schedules and repository
usual profiles. Compare current repository metadata to the snapshot; do not assume an old snapshot
is still current. Do not edit running pods or frozen launch records.

Before consolidating a Node overlay environment:

- Preserve checksum-pinned gitleaks, actionlint and ShellCheck requirements and verify their actual
  versions. These binaries are not silently added to every standard image. Retain their reviewed,
  checksum-verified `prepareCommands` in a generic environment named for its tools, or in appropriate
  repository setup preparation. The environment `tools` installer supports npm/pip/dotnet tools,
  not arbitrary actionlint/ShellCheck/gitleaks names. Do not claim those names are supported there.
- For Pod desk, replace `npm_config_nodedir=/home/autopod/.local/node24` with `/usr/local` in the
  complete repository setup payload together with removal of the Node overlay. Prove native
  dependencies build/load with its actual lockfile and normal validation. Retain gitleaks 8.30.1
  (or an independently reviewed replacement) before moving its profile's `environmentId`.
- For xpm-vibe, inspect launch-local overrides and the exact Node assertion even when no usual
  profile exists. Keep its exact-version environment until a digest demonstrably satisfies it.
- For Scruffy, run the actual validationSetupCommand and DB tests, including fresh initialization
  and restart; preserve PGDATA, PGHOST=127.0.0.1, PGPORT=5433 and wrapper permissions.

## Update the three reusable presets in place

Only after image, representative repository, backend and native desktop checks pass, map the
standard Node22, Node22+Playwright and Node22+Playwright+PostgreSQL presets respectively to
`node24`, `node24-pw`, `node24-pw-pg`, renaming them to Node24 equivalents. Preserve each ID and
all unrelated payload fields. Keep Node22 holdout profiles on a separately retained generic
compatibility environment before changing a widely referenced preset.

Example for one environment; repeat serially, validating after each change:

```bash
# Set ENVIRONMENT_ID to the operator-verified ID. show refuses to overwrite an existing file.
ap preset environment show "$ENVIRONMENT_ID" --output before-environment.json
jq '.payload | .template = "node24-pw"' before-environment.json > candidate-payload.json
revision=$(jq -r '.revision' before-environment.json)
# Review full diff and dependencies before this explicitly gated live operation.
ap preset environment update "$ENVIRONMENT_ID" --file candidate-payload.json \
  --expected-revision "$revision" --name 'Node 24 + Playwright'
ap preset environment show "$ENVIRONMENT_ID" --output after-environment.json
```

Even rename requires a complete payload and expected revision. On conflict, STOP and re-inventory;
do not overwrite concurrent edits or automatically retry with a fresh revision. Verify the ID is
unchanged and only intended fields differ. New launches must record the intended template and
immutable image; run normal validation/review. Existing frozen launches retain their identities.
For profile environmentId and repository header-path updates use `ap profile update` and
`ap repository update` with complete saved payloads and `--expected-revision` in the same way.
Update repository setup/header assumptions and retain tooling before switching the profile.

## Cleanup and rollback

After successful canaries and an observation window, recheck every dependency class above and
archive redundant task-named environments with
`ap preset environment archive "$DUPLICATE_ID" --expected-revision "$REVISION"`.
Retain generic compatibility/tooling environments where required. Archive only when current and
future launches no longer select the duplicate and recovery remains supported; defer archival
for unresolved historical dependencies. Do not delete records or images. AI setups/accounts and
unrelated presets are outside this operation.

Before archival, exercise the supported recovery path on the actual daemon version. The current
CLI exposes archive but no unarchive command: do not assume it can undo archival. Keep duplicates
unarchived throughout rollback testing; defer archival if restoring their selection may be needed.

To roll back a preset/profile/repository edit, stop admitting affected new work, fetch its current
revision, compare against the recorded post-change document for concurrent edits, and submit the
saved **complete original payload and name** with that current expected revision. Preserve the ID;
never copy the old revision number forward. Restore profile references and repository header/tool
preparation coherently. Do not roll back frozen active pods. If image tags were advanced, an
operator must restore the recorded prior registry manifests using the approved registry release
procedure and verify their digests, or select the retained immutable base via the supported
`baseImage` field and rebuild/validate new environment images. Rolling back presets alone does
not restore overwritten latest tags. Retain before/after snapshots and smoke receipts until the
recovery window closes. No direct SQLite writes or startup data migration is involved.
