# GPT-6.2 worker runtime qualification

Pod `happy-falcon` started from supplied SHA
`e2babdebcf797e970399230d00f2ad2404f5ca2f`, exactly the researched baseline.
No remote refresh was performed. The desktop picker and prices from #611 are
unchanged. The [OpenAI API changelog](https://developers.openai.com/api/docs/changelog)
records `gpt-6.2-sol` and `gpt-6.2-astra` on November 17, 2026.
The supported image pins are `@openai/codex@0.171.0` and
`@earendil-works/pi-coding-agent@1.6.0`.

## Inventory and rebuild scope

| Path | Runtime source | Operator work before qualification |
| --- | --- | --- |
| `templates/base/Dockerfile.*` (14 recipes) | Both pinned CLIs plus built `@autopod/pi-worker` | Rebuild every base used by OpenAI-capable workers: node22, node22-pw, node22-pw-pg, node24, node24-pw, node24-pw-pg, dotnet9, dotnet10, dotnet10-go, python312, python-node, python-node-pg, go124, go124-pw. |
| `templates/managed/Dockerfile.codex-local` | Codex pin | Build a separate candidate; bind its immutable image ID only in an isolated candidate configuration. |
| `templates/managed/Dockerfile.codex-portfolio` | Default `CODEX_VERSION` build argument | Rebuild with the explicitly enrolled portfolio source revision; an old image digest retains its old CLI. |
| `templates/system/Dockerfile.decision` | Codex and Pi build arguments | Rebuild the repo-free decision image separately. It uses Pi print/JSON mode, without the managed worker extension. |
| `packages/daemon/src/images/{dockerfile-generator,image-builder,environment-dockerfile}.ts` | Warm/environment images inherit the resolved base digest; no stock CLI reinstall | Rebuild affected environment images and rewarm each affected profile against the rebuilt base digest. Explicit environment CLI overrides remain owner choices. Refreshing a base tag alone does not alter old warm images or frozen launches. Custom images need their owner to rebuild them. |
| `scripts/publish-base-images.mjs`, `publish-managed-codex-image.mjs`, `build-system-decision-image.sh` | Build the recipes above | Their publication modes are operator-owned; no image was published by this pod. |
| `scripts/deploy-hosted-daemon.sh`, `src/runtimes/run-claude-cli.ts`, `host-cli-provenance.ts` | Host CLI PATH/version probes; deployment installs missing Codex from configurable `CODEX_CLI_NPM_PACKAGE` (default unversioned) | Host reviewer binaries are independent of worker images. An existing binary is not upgraded by that script. Inventory the observed executable/version separately; no host install, deployment or credential access was performed here. |

GPT-6.2 Codex preflight requires **0.171.0**. The existing GPT-6/6.1 floor
remains 0.160.1 and the general floor remains 0.144.4. The shared container
execution preflight uses the actual worker/reviewer model and reports
`PREFLIGHT_RUNTIME_INCOMPATIBLE` with the required version and base/warm image
rebuild guidance. Host provenance is an identity probe, not this container floor.

Historical 0.160.1 live Goal/RPI receipts and their fixtures remain unchanged.
Older synthetic catalog-response fixtures still exercise older snapshots. Only
the current compiled Pi compatibility metadata and missing-CLI installation hint
advance to 1.6.0; provider authorization and model allowlists do not change.
The explicitly scoped `inspection-codex-v1` policy remains `gpt-5.6-sol`/low.

## Actual package checks (Linux, Node 22.23.5)

Installed into disposable prefixes, outside the repository dependency graph:

```sh
npm install --prefix /tmp/happy-falcon-runtimes --no-audit --no-fund \
  @openai/codex@0.171.0 @earendil-works/pi-coding-agent@1.6.0
npm install --prefix /tmp/happy-falcon-pi-before --no-audit --no-fund \
  @earendil-works/pi-coding-agent@0.80.6
```

From the repository root, reproduce the credential-free version, catalog and
paused Goal checks with:

```sh
node scripts/check-gpt62-runtime-packages.mjs /tmp/happy-falcon-runtimes
AUTOPOD_CODEX_GOAL_FIXTURE_CLI=/tmp/happy-falcon-runtimes/node_modules/.bin/codex \
  npx pnpm --filter @autopod/daemon exec vitest run src/runtimes/codex-goal-protocol.native.test.ts
```

Both checks also passed on macOS with Node 24.22.1. The native Goal fixture
verifies that a paused Goal persists across fresh app-server processes without
resuming it. These checks do not exercise inference.

- Codex reports `codex-cli 0.171.0`; Pi reports `1.6.0`.
  Codex `debug models --bundled` contains both explicit IDs. App-server stdio
  `initialize` followed by `model/list` succeeds without credentials and lists both.
  The probe used empty temporary HOME/CODEX_HOME and a fresh environment.
  Codex warned about temporary-path helper aliases and used bundled bubblewrap;
  no sandboxed tool execution or inference was proven by this handshake.
- Pi 1.6.0 `openaiProvider().getModels()` and
  `openaiCodexProvider().getModels()` contain both IDs, with
  `openai-responses` and `openai-codex-responses` respectively. These factories
  are in the installed `@earendil-works/pi-ai/dist/providers/{openai,openai-codex}.js`.
  The old top-level `getModels` export is absent in 1.6.0; Autopod does not import it.
- Native Pi RPC `get_state` succeeded for all four provider/model combinations
  with `--mode rpc --offline --no-session --no-tools --no-extensions --no-mcp
  --no-skills --no-prompt-templates --no-themes --no-context-files`. Each process
  had a fresh HOME and PI_CODING_AGENT_DIR, with no inherited credentials.
  Empty `auth.json` and `models-store.json` were created only in those directories.
- Pi's engine floor is unchanged from 0.80.6: Node >=22.19.0. The fixed decision
  base is exactly 22.19.0; managed-local is 22.23.1; portfolio is 24.18.0;
  other bases use Node 22/24 slim or NodeSource 22. Pi/undici metadata requires
  no Node recipe change. Actual image construction remains untested here.
- Pi retains PI_CODING_AGENT_DIR and the provider-keyed `auth.json` shape
  (`api_key`/`key`, or `oauth`/`access`/`refresh`/`expires`), including command-backed
  API keys. Autopod's isolated auth directories and transport-only extension
  build and bridge unit checks pass. Existing sessions/auth/settings were not
  imported or migrated.

### Pre-existing managed Pi incompatibility: not qualified

Autopod's current `PiRuntime` invokes `pi rpc --managed --worker-config ...
--worker-package @autopod/pi-worker --worker-entrypoint @autopod/pi-worker
--extension-id ... --disable-project-extensions
--disable-executable-project-resources --jsonl`.
**Neither actual 0.80.6 nor 1.6.0 implements those flags.** Both credential-free
launches exited 1 with `Error: File not found: <scratch>/autopod/pi-worker`:
the unrecognized flag's `@autopod/pi-worker` value becomes an input-file argument.
This is reproducible with the command above, a temporary empty worker-config JSON,
and either installed CLI. Loading the built worker package cannot fix missing CLI
support for that command line.

The native RPC schema also uses `{id,type:"prompt",message}` and
`{type:"response",command,success,data/error}`. Autopod's managed runtime sends
`{id,method,params}` and expects `result` or an object-valued `error`. Native Pi's
extension loader expects a native extension entrypoint, while the existing worker
exports a named transport initializer. Unit mocks do not prove this integration.
Both versions already have the mismatch; no adapter rewrite is included because
this task permits only compatibility fixes introduced by the version bumps.
**Managed Pi end-to-end support remains a separate source compatibility gap.**
Native Pi startup/catalog results must not be reported as a successful managed
Autopod launch, and a managed Pi smoke must not be waived based on passing mocks.

## Candidate image and live checks: NOT RUN here

Docker is absent (`command -v docker` returns no executable). No candidate
image build, registry build/push, hosted launch, rewarm or live account inference
was attempted. Run the following on a Docker-capable operator workstation using
this committed source, with no production daemon socket/config/auth mounts.
These are candidate qualification steps, not rollout instructions.
The command blocks below use Bash.

Build locally and retain immutable identities (serialize the builds):

```sh
for recipe in templates/base/Dockerfile.*; do
  template=${recipe##*.}
  docker build --platform linux/amd64 -f "$recipe" \
    -t "happy-falcon-candidate:$template" . || exit 1
  docker image inspect "happy-falcon-candidate:$template" --format '{{.Id}}'
done
docker build --platform linux/amd64 -f templates/managed/Dockerfile.codex-local \
  -t happy-falcon-candidate:managed-local .
docker build --platform linux/amd64 -f templates/system/Dockerfile.decision \
  -t happy-falcon-candidate:decision .
BASE_CANDIDATE_ID=$(docker image inspect happy-falcon-candidate:node22 --format '{{.Id}}')
MANAGED_CANDIDATE_ID=$(docker image inspect happy-falcon-candidate:managed-local --format '{{.Id}}')
DECISION_CANDIDATE_ID=$(docker image inspect happy-falcon-candidate:decision --format '{{.Id}}')
```

For portfolio, set PORTFOLIO_CHECKOUT, PORTFOLIO_REV (full enrolled SHA) and
PORTFOLIO_URL explicitly. This uses only local Git objects, without a refresh:

```sh
portfolio_context=$(mktemp -d)
mkdir -p "$portfolio_context/templates/base"
cp templates/base/{install-worker-git,check-worker-git,check-worker-jq}.sh \
  "$portfolio_context/templates/base/"
git -C "$PORTFOLIO_CHECKOUT" archive --format=tar "$PORTFOLIO_REV" \
  > "$portfolio_context/source.tar"
docker build --platform linux/amd64 -f "$PWD/templates/managed/Dockerfile.codex-portfolio" \
  --build-arg "REPOSITORY_URL=$PORTFOLIO_URL" --build-arg "BASE_REVISION=$PORTFOLIO_REV" \
  -t happy-falcon-candidate:portfolio "$portfolio_context"
```

Use immutable candidate IDs for each run. For base images run
`bash scripts/smoke-worker-git.sh IMAGE_ID` and the applicable
`bash scripts/smoke-node24-images.sh TEMPLATE IMAGE_ID`; inspect `node --version`,
`codex --version`, `pi --version` and `codex debug models --bundled` inside the
candidate. Pi native RPC can be probed without credentials like this:

```sh
for provider in openai openai-codex; do
  for model in gpt-6.2-sol gpt-6.2-astra; do
    printf '%s\n' '{"id":"state","type":"get_state"}' | \
      docker run --rm -i --network none --read-only --tmpfs /tmp \
        -e HOME=/tmp/probe -e PI_CODING_AGENT_DIR=/tmp/probe/pi \
        -e PI_OFFLINE=1 -e PI_TELEMETRY=0 "$BASE_CANDIDATE_ID" \
        pi --mode rpc --offline --no-session --no-tools --no-extensions --no-mcp \
        --no-skills --no-prompt-templates --no-themes --no-context-files \
        --model "$provider/$model"
  done
done
```

For live Codex, create a **new disposable** operator auth directory with a
dedicated test account using the candidate CLI's `codex login`. Do not mount
existing daemon or user Codex homes. Use its auth file and a disposable local
canary repository with the existing isolated managed RPI test, once per ID:

```sh
codex_candidate_home=$(mktemp -d)
docker run --rm -it --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$codex_candidate_home,dst=/candidate" \
  -e HOME=/candidate -e CODEX_HOME=/candidate/codex "$MANAGED_CANDIDATE_ID" \
  codex login --device-auth
DISPOSABLE_CODEX_AUTH_FILE="$codex_candidate_home/codex/auth.json"
# Set DISPOSABLE_CANARY_REPOSITORY to a separate local test repository.
for model in gpt-6.2-sol gpt-6.2-astra; do
  AUTOPOD_MANAGED_DOCKER_IMAGE="$MANAGED_CANDIDATE_ID" \
  AUTOPOD_MANAGED_LIVE_AUTH_FILE="$DISPOSABLE_CODEX_AUTH_FILE" \
  AUTOPOD_MANAGED_LIVE_REPOSITORY="$DISPOSABLE_CANARY_REPOSITORY" \
  AUTOPOD_MANAGED_LIVE_MODEL="$model" \
  AUTOPOD_MANAGED_LIVE_REPORT="/tmp/happy-falcon-$model.json" \
    npx pnpm --filter @autopod/daemon exec vitest run src/managed/live-rpi.docker.test.ts
done
```

Also run the credential-free managed component suite with
`AUTOPOD_MANAGED_DOCKER_IMAGE="$MANAGED_CANDIDATE_ID" npx pnpm --filter
@autopod/daemon exec vitest run src/managed/local-runtime.docker.test.ts`.
For live native Pi, use separate disposable directories and dedicated test
accounts. Repeat the following for `provider=openai-codex` and `provider=openai`
(the API-key login prompts interactively; do not pass keys in arguments):

```sh
provider=openai-codex
pi_candidate_home=$(mktemp -d)
login_options=(--no-browser)
if [ "$provider" = openai ]; then login_options=(--api-key); fi
docker run --rm -it --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$pi_candidate_home,dst=/candidate" \
  -e HOME=/candidate -e PI_CODING_AGENT_DIR=/candidate/pi -e PI_TELEMETRY=0 \
  "$BASE_CANDIDATE_ID" pi auth login "$provider" "${login_options[@]}"
for model in gpt-6.2-sol gpt-6.2-astra; do
  docker run --rm --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$pi_candidate_home,dst=/candidate" \
    -e HOME=/candidate -e PI_CODING_AGENT_DIR=/candidate/pi -e PI_TELEMETRY=0 \
    "$BASE_CANDIDATE_ID" pi --print --mode json --no-session --no-tools \
    --no-extensions --no-mcp --no-skills --no-prompt-templates --no-themes \
    --no-context-files --model "$provider/$model" 'Reply with exactly OK'
done
```

A live managed Pi launch additionally requires
resolving the pre-existing adapter mismatch above and proving required escalation
tool initialization, a tool call and terminal evidence; it is currently unqualified.

After candidate qualification, owners can plan base publication, affected profile
rewarming and separate hosted CLI reconciliation. None is authorized or performed
by this worker. Shared profiles, defaults and frozen launches stay unchanged.

## Repository verification

Executed serially on this supplied source (no skipped focused tests):

- `npx pnpm install --frozen-lockfile` and `npx pnpm build --concurrency=1`: passed.
- `npx pnpm --filter @autopod/daemon test -- agent-cli-preflight.test.ts`: passed,
  5 tests; `npx pnpm --filter @autopod/daemon test -- dockerfile-generator.test.ts`:
  passed, 80 tests. These are the two required fact commands.
- `npx pnpm --filter @autopod/daemon test -- dockerfile-generator.test.ts
  agent-cli-preflight.test.ts codex-runtime.test.ts pi-runtime.test.ts
  pi-rpc-parser.test.ts execution-preflight.test.ts review-codex-runner.test.ts
  system-decision-runner.test.ts --maxWorkers=1`: passed, 297 tests.
- `npx pnpm --filter @autopod/pi-worker test`: passed, 9 tests covering the MCP
  bridge and required extension initialization.
- `npx pnpm --filter @autopod/shared test -- provider-catalog.test.ts`: passed,
  19 tests; `npx pnpm --filter @autopod/cli test -- provider-account.test.ts
  provider-catalog.test.ts`: passed, 27 tests.
- `node --test scripts/publish-base-images.test.mjs
  scripts/publish-managed-codex-image.test.mjs`: passed, 12 mocked publication
  tests; `bash scripts/build-system-decision-image.test.sh`: passed.
- `npx pnpm --filter @autopod/daemon test -- base-template.test.ts
  worker-git.test.ts worker-jq.test.ts codex-app-server-client.test.ts --maxWorkers=1`:
  passed, 109 tests. Targeted Biome checks pass with existing warnings in unchanged
  image-test lines (the initial import/format errors in new tests were corrected).

The enabled daemon gates and independent review remain daemon-owned. Passing
repository mocks/builds is separate from the missing image/live proofs above.
