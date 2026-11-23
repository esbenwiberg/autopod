# GPT-6.2 worker runtime qualification

Pod `happy-falcon` started from clean supplied SHA
`e2babdebcf797e970399230d00f2ad2404f5ca2f`, exactly the researched baseline.
No authenticated refresh was attempted. The previous-attempt commit list was
baseline history, not a partially implemented runtime bump.

## Image inventory and rebuild order

| Path | Runtime source | Required operator action |
| --- | --- | --- |
| `templates/base/Dockerfile.*` (all 14) | Codex 0.171.0 and Pi 1.6.0; bundled `@autopod/pi-worker` built from source | Build isolated candidates for every used stack |
| `templates/managed/Dockerfile.codex-local` | Codex 0.171.0 only | Rebuild local managed candidate; select its immutable ID only in an isolated test configuration |
| `templates/managed/Dockerfile.codex-portfolio` | `CODEX_VERSION=0.171.0` | Rebuild with the independently selected exact portfolio source archive/revision |
| `templates/system/Dockerfile.decision` | Codex 0.171.0, Pi 1.6.0 | Rebuild repo-free decision candidate |
| `images/dockerfile-generator.ts`, `environment-dockerfile.ts`, `image-builder.ts` | Warm/environment images inherit their resolved base; no stock CLI reinstall | Rewarm against the new base digest; an existing warm image retains old CLIs regardless of age |
| Hosted workers/reviewers | Configured registry image/digest, including immutable managed images and reviewer images selected by `configuration/host-components.ts` | Qualify separate hosted candidates after an independently authorized publication; checked-in changes do not replace existing digests |
| Hosted system decisions | `AUTOPOD_SYSTEM_DECISION_IMAGE`; local uses `AUTOPOD_SYSTEM_DECISION_LOCAL_IMAGE` | Qualify new isolated image references; no live setting changes in this task |

Node22 base recipes use `node:22-slim` or NodeSource 22; Node24 recipes use
`node:24-slim`. The managed local image pins 22.23.1, portfolio pins 24.18.0,
and decision pins 22.19.0. Pi 1.6.0 declares Node `>=22.19.0`; these sources
are compatible. Candidate builds must still verify the actually resolved Node
patch version, especially mutable NodeSource/major tags. No Node bump is needed.

Historical 0.160.1 canaries, usage fixtures and the executed proof in
`managed-local-docker.md` remain unchanged. The compiled provider manifest's
0.80.6 compatibility provenance and its client fixtures are a separate scoped
catalog, not worker installation pins; this task does not requalify that catalog
or migrate local provider authentication. The `inspection-codex-v1` controller's
explicit `gpt-5.6-sol` policy remains unchanged. Desktop picker/prices, provider
sessions/settings/auth, shared profiles and defaults remain unchanged.

## Actual package evidence

Reproduce on Node >=22.19.0, without installing into the repository or changing
global CLIs:

```sh
npm install --prefix /tmp/happy-falcon-runtime --no-audit --no-fund \
  @openai/codex@0.171.0 @earendil-works/pi-coding-agent@1.6.0
node scripts/check-gpt62-runtime-packages.mjs /tmp/happy-falcon-runtime
AUTOPOD_CODEX_GOAL_FIXTURE_CLI=/tmp/happy-falcon-runtime/node_modules/.bin/codex \
  npx pnpm --filter @autopod/daemon test -- codex-goal-protocol.native.test.ts
```

PASS: exact installed versions, credential-free Codex initialize/model-list
(including both explicit IDs), paused Goal persistence across fresh processes,
and native Pi `get_state` for both `gpt-6.2-sol` and `gpt-6.2-astra` on each of
`openai` and `openai-codex`. The checker creates fresh HOME/CODEX_HOME/Pi dirs,
passes an allowlisted environment without credentials, and removes its state.
These are catalog/protocol checks, not inference. Codex reports missing system
bubblewrap and uses its bundled fallback in this container; the protocol check
still passes.

Focused checks passed:

| Command | Result |
| --- | --- |
| `npx pnpm --filter @autopod/daemon test -- agent-cli-preflight.test.ts` | 6 tests |
| `npx pnpm --filter @autopod/daemon test -- dockerfile-generator.test.ts` | 80 tests |
| `npx pnpm --filter @autopod/daemon test -- codex-runtime.test.ts pi-runtime.test.ts pi-rpc-parser.test.ts` | 152 tests |
| `npx pnpm --filter @autopod/pi-worker test` | 9 bridge/extension tests |
| `npx pnpm --filter @autopod/daemon test -- execution-preflight.test.ts review-codex-runner.test.ts container-reviewer-runner.test.ts runtime-adapters.test.ts` | 61 tests across the three existing matching suites; no separate runtime-adapters test file |
| `npx pnpm --filter @autopod/daemon test -- execution-preflight.test.ts` | 24 tests after adding worker/reviewer GPT-6.2 boundary cases |
| `npx pnpm --filter @autopod/daemon test -- env-builder.test.ts system-decision-runner.test.ts` | 44 tests, including provider injection/auth-directory contracts |
| `node --test scripts/publish-base-images.test.mjs scripts/publish-managed-codex-image.test.mjs` | 12 fixture tests; no actual publication |
| `bash scripts/build-system-decision-image.test.sh` | Publication contract passed; no build/publication |

The first preflight invocation failed because repository dependencies were absent
(`tsup: not found`). `npx pnpm install --frozen-lockfile` succeeded, and the
subsequent required checks passed. No lockfile or dependency declaration changed.

### Existing Pi managed integration gap

Stock Pi 1.6.0 does **not** implement Autopod's `pi rpc --managed` startup
contract. Comparing actual installed 0.80.6 and 1.6.0 packages in fresh homes
shows the same failure before RPC startup:
`Error: File not found: <fresh cwd>/autopod/pi-worker`.
Both treat the existing `@autopod/pi-worker` arguments as file inputs.
This predates the version bump.

The existing adapter sends `{id,method,params}` commands and expects
`response.result`/object errors and synthetic completion events. Stock 1.6.0
uses `--mode rpc`, `{id,type,message}`, `response.success/data`/string errors,
and `agent_settled`. The checked-in worker exports named
`initializePiWorkerExtension(config, registry)`; it is not a stock Pi default
extension entrypoint. Passing its file as `-e` is not a sufficient repair.
Mock runtime/bridge tests passing does not qualify this integration. Native Pi
catalog/protocol startup passes independently; managed Pi worker inference
remains unqualified until the adapter/extension is repaired separately.

Exact comparison (after installing 0.80.6 into a second disposable prefix):

```sh
npm install --prefix /tmp/happy-falcon-old-pi --no-audit --no-fund \
  @earendil-works/pi-coding-agent@0.80.6
for prefix in /tmp/happy-falcon-old-pi /tmp/happy-falcon-runtime; do
  probe=$(mktemp -d)
  (cd "$probe" && env -i PATH="$PATH" HOME="$probe" \
    PI_CODING_AGENT_DIR="$probe/agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
    "$prefix/node_modules/.bin/pi" rpc --managed --model gpt-6.2-sol \
      --worker-config "$probe/worker.json" --worker-package @autopod/pi-worker \
      --worker-entrypoint @autopod/pi-worker --extension-id autopod-managed-mcp-worker \
      --disable-project-extensions --disable-executable-project-resources --jsonl)
  rm -rf "$probe"
done
```

Pi 1.6.0 still resolves auth storage under `PI_CODING_AGENT_DIR/auth.json`,
matching provider injection and isolated auth-directory handling. No existing
auth file was used for the package/protocol checks.

## Candidate image and live checks — NOT RUN

This worker has no Docker executable/socket and no dedicated live canary account.
No images were built/published, no daemon credentials accessed, no deployment or
default migration performed. The following are operator steps, not executed proof.
Run serially on an isolated Docker host, from this committed checkout:

```sh
for recipe in templates/base/Dockerfile.*; do
  stack=${recipe##*.}
  docker build --pull -f "$recipe" -t "happy-falcon-$stack:candidate" .
  docker run --rm --network none --entrypoint sh "happy-falcon-$stack:candidate" \
    -c 'node --version; codex --version; pi --version; test -f "$(npm root -g)/@autopod/pi-worker/dist/index.js"'
done
docker build --pull -f templates/managed/Dockerfile.codex-local \
  -t happy-falcon-managed:candidate .
SYSTEM_DECISION_IMAGE=happy-falcon-decision:candidate \
  bash scripts/build-system-decision-image.sh
```

For portfolio, prepare a private build context containing the checked-in Dockerfile,
`templates/base/{install-worker-git,check-worker-git,check-worker-jq}.sh`, and
`source.tar` produced by `git -C "$PORTFOLIO_SOURCE" archive --format=tar
--output="$CONTEXT/source.tar" "$PORTFOLIO_SHA"`. Then run:

```sh
docker build --pull -f templates/managed/Dockerfile.codex-portfolio \
  --build-arg "REPOSITORY_URL=$PORTFOLIO_URL" --build-arg "BASE_REVISION=$PORTFOLIO_SHA" \
  -t happy-falcon-portfolio:candidate "$CONTEXT"
```

Use `docker image inspect IMAGE --format '{{.Id}}'` to bind each launch to its
immutable local candidate ID. Do not reuse a running production worker, modify
shared profiles, or repoint existing warm/reviewer/system settings. Rewarm only
an isolated copy of the environment against the candidate base ID, then run the
same version checks on the resulting image.

For credentialed native CLI smoke, use a dedicated canary login in a **new**
directory (no daemon auth export, no mount of existing provider homes):

```sh
canary=$(mktemp -d)
chmod 700 "$canary"
image=$(docker image inspect happy-falcon-node24:candidate --format '{{.Id}}')
docker run --rm -it --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$canary,dst=/canary" --entrypoint sh "$image" \
  -c 'mkdir -p /canary/codex /canary/pi; HOME=/canary CODEX_HOME=/canary/codex codex login --device-auth'
docker run --rm -it --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$canary,dst=/canary" --entrypoint sh "$image" \
  -c 'HOME=/canary PI_CODING_AGENT_DIR=/canary/pi pi auth login openai-codex'
for model in gpt-6.2-sol gpt-6.2-astra; do
  docker run --rm --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$canary,dst=/canary" --entrypoint sh "$image" \
    -c 'cd /tmp; HOME=/canary CODEX_HOME=/canary/codex codex exec --json --ephemeral --sandbox read-only --skip-git-repo-check --model "$1" "Reply exactly GPT62_OK"' sh "$model"
  docker run --rm --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$canary,dst=/canary" --entrypoint sh "$image" \
    -c 'cd /tmp; HOME=/canary PI_CODING_AGENT_DIR=/canary/pi pi --print --mode json --no-session --no-tools --no-mcp --no-extensions --no-skills --no-context-files --model "openai-codex/$1" "Reply exactly GPT62_OK"' sh "$model"
done
rm -rf "$canary"
```

For Pi's `openai` route, independently log in with `pi auth login openai
--api-key` in that disposable directory and repeat both IDs with
`--model "openai/$1"`. Confirm terminal success and reported exact model IDs,
not just accepted arguments. Repeat Codex native smoke on managed/portfolio/
decision candidates (Pi native smoke applies to base/decision only).
Native smoke does not prove Autopod's managed Pi bridge works.

For the actual managed Codex channel, supply a dedicated disposable auth file
and canary repository to the existing isolated fixture, once per ID:

```sh
for model in gpt-6.2-sol gpt-6.2-astra; do
  AUTOPOD_MANAGED_DOCKER_IMAGE="$MANAGED_CANDIDATE_ID" \
  AUTOPOD_MANAGED_DOCKER_SOCKET=/var/run/docker.sock \
  AUTOPOD_MANAGED_LIVE_AUTH_FILE="$DEDICATED_CANARY_AUTH_FILE" \
  AUTOPOD_MANAGED_LIVE_REPOSITORY="$CANARY_REPOSITORY" \
  AUTOPOD_MANAGED_LIVE_MODEL="$model" \
  npx pnpm --filter @autopod/daemon test -- live-rpi.docker.test.ts
done
```

This fixture uses disposable state/containers and keeps the original repository
main unchanged. It performs paid inference and requires separate operator
execution; no successful fixture or native smoke is claimed here.
