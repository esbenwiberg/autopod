# Azure Container Apps Sandboxes

Autopod can provision `executionTarget: sandbox` containers in Azure Container Apps Sandboxes.
This target is production-supported only with Autopod warm images published to ACR.

## Current Contract

Supported:

- Short, buffered command execution through the sandbox data plane.
- Streaming command execution (agent runtimes) over the data plane's WebSocket endpoint
  (`wss://…/sandboxes/{id}/exec/stream`), the same transport used by the
  `@azure/containerapps-sandbox` reference SDK's `createExecStreamSession`.
- File upload/download/list operations.
- Snapshot workspace sync-in and sync-back through `/workspace`.
- Container-local validation probes for health and pages at `http://127.0.0.1:3000`.
- Stop/resume and native sandbox egress-policy refresh.
- Interactive terminal (`ap shell` / `ap attach`, `WS /pods/:podId/terminal`) over the exec-stream
  WebSocket TTY variant (`tty`/`stdin`/`resize` frames), with tmux-reattach parity where the warm
  image ships tmux. Validated live 2026-07-08.
- Host preview URLs, two modes (see "Native Port Exposure" below):
  - **Default**: daemon-side exec proxy (`sandbox-preview-proxy.ts`) → a daemon-local
    `http://127.0.0.1:<hostPort>` URL.
  - **Opt-in**: set `AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS` and sandbox pods instead expose their
    app port on the platform's native public URL (`*.adcproxy.io`), Entra-gated to those emails.
    Native-first with automatic fallback to the exec proxy; reachability is then probed inside the
    sandbox (the Entra gate makes a host-side probe return 401). Local (Docker) pods are unaffected.

Explicitly unsupported until Autopod wires up the remaining pieces:

- Source-IP ACLs (`ipAccessControl`) on exposed ports — the reference SDK's `addPort` doesn't model
  them yet.
- Sidecars. Reason: current sidecars require a Docker bridge network shared with the pod container.

## Exec Streaming Transport

The preview Python SDK (`azure-containerapps-sandbox==0.1.0b3`) only exposes buffered
`exec()`. The streaming transport below was confirmed from the newer JS reference SDK
(`@azure/containerapps-sandbox@1.0.0-beta.1`, shipped inside `@acaexpress/containerapps-cli`),
which uses it for both one-shot streaming exec and interactive `sandbox shell`:

- Endpoint: `wss://management.<region>.azuredevcompute.io/subscriptions/{sub}/resourceGroups/{rg}/sandboxGroups/{group}/sandboxes/{id}/exec/stream` (no `api-version` query parameter).
- Auth: `Authorization: Bearer <token>` header on the WebSocket upgrade.
- Client → server frames (JSON text):
  - `{"type":"start","start":{"command":"…","environment":{…},"tty":bool,"stdin":bool,"height":N,"width":N}}` — sent once on open. No working-directory or user field.
  - `{"type":"stdin","data":"<base64>"}` — interactive input (TTY sessions).
  - `{"type":"resize","width":N,"height":N}` — terminal resize (TTY sessions).
- Server → client frames: `{"type":"stdout"|"stderr","data":"<base64>"}`, terminal
  `{"type":"exit_code","exitCode":N}`, and `{"type":"error",…}`.

**`start.command` is a single path, `execve`d literally — not a shell string.** Live
validation (2026-07-08, `swedencentral`) showed the runtime treats `command` as `argv[0]`
with no shell interpretation and no arguments: a joined `sh -lc '…'` string fails with
`executable file not found in $PATH`. The reference SDK only ever sends a bare binary
(`/bin/bash`) here and drives real work through stdin. To run an arbitrary argv with
streaming output, `AzureSandboxApiClient.execStream()` stages the command as an executable
`#!/bin/sh` wrapper script (writeFile → the files API writes it as `root:0644`, so a
`chmod 0755` as `root` follows → so the non-root sandbox process can `execve` it) and sends
that script path as `command`. `cwd` is folded into the wrapper (`cd … || exit 1`); `env`
rides the start frame's `environment`.

Autopod's `AzureSandboxApiClient.execStream()` implements the non-TTY variant, which flips
`SandboxContainerManager.supportsStreamingExec` to `true` and unblocks agent runtimes on
this target. The TTY variant is available for a future interactive-terminal integration
(daemon terminal route — see the interactive-pods caveat above).

The data-plane token scope is `https://dynamicsessions.io/.default` for both the HTTPS
data plane and the WebSocket upgrade — the live run confirmed no per-endpoint scope split is
needed. The exec-stream WebSocket accepts the Bearer token via undici's `headers` option on
the upgrade, against the regional `management.<region>.azuredevcompute.io` endpoint, with no
`api-version` query parameter.

## Native Port Exposure

The data plane can expose an in-sandbox port on a public URL, an alternative to the daemon-side
exec proxy. `SandboxApiClient.addPort(sandboxId, port, auth?)` / `removePort(sandboxId, port)`:

- `POST {sandboxPath}/ports/add` with `{ "port": N }` plus optional
  `{ "auth": { "entraId": { "enabled": true, "emails": [...] } } }` or `{ "auth": { "anonymous": true } }`.
  Autopod defaults to **Entra** auth — never silently anonymous.
- The public URL is assigned **asynchronously**: the POST response has no `url`; it surfaces on the
  sandbox object's `ports[].url` a few seconds later, so `addPort` polls `getSandbox` for it. URL
  shape: `https://<sandboxId>--<port>.<region>.adcproxy.io`.
- `POST {sandboxPath}/ports/remove` with `{ "port": N }` (idempotent).

**Validated live 2026-07-08** (`swedencentral`): an Entra-gated port yielded
`https://…--3000.swedencentral.adcproxy.io`; an unauthenticated request returned **401** (gated, no
leak), and after `removePort` the URL returned **404**. Source-IP ACLs (`ipAccessControl`) are not
yet modeled — the reference SDK's `addPort` doesn't set them; tracked as a follow-up.

**Preview integration.** `pod-manager`'s `ensureSandboxPreviewProxy` prefers native exposure when
`AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS` is set (comma/space-separated Entra allowlist — this is both
the enable switch and where you put your own UPN/email), and falls back to the exec proxy if unset
or on any failure. When native is active, `pod.previewUrl` is the `adcproxy.io` URL and the preview
supervisor probes app reachability **inside** the sandbox (`curl localhost:3000`) since a host-side
probe of the Entra-gated URL would just see 401. `removePort` runs on preview teardown. Local
(Docker) pods are unaffected — they keep their `http://127.0.0.1:<hostPort>` path.

## Preview Tunnel Proof

Sandbox app preview needs an outbound reverse tunnel because Azure Sandboxes do
not expose inbound app ports. Before building the daemon-owned tunnel broker,
prove the core runtime behavior with Cloudflare quick tunnels:

```bash
npx pnpm --filter @autopod/daemon build

SANDBOX_IMAGE=<acr-qualified-warm-image> \
AZURE_SUBSCRIPTION_ID=<subscription-id> \
AZURE_RESOURCE_GROUP=<resource-group> \
AZURE_SANDBOX_GROUP=<sandbox-group> \
node scripts/prove-sandbox-preview-tunnel.mjs
```

The proof creates a disposable sandbox, writes a tiny Node HTTP server listening
on `127.0.0.1:3000`, downloads `cloudflared`, starts
`cloudflared tunnel --url http://127.0.0.1:3000` inside the sandbox, waits for a
temporary `trycloudflare.com` URL, then fetches that public URL from the daemon
host and verifies a random proof token.

By default the proof uses `allow-all` egress so a failure isolates tunnel/runtime
behavior instead of allowlist tuning. To also prove restricted egress:

```bash
SANDBOX_TUNNEL_NETWORK=restricted \
SANDBOX_TUNNEL_ALLOWED_HOSTS='github.com,*.github.com,*.githubusercontent.com,*.githubassets.com,cloudflare.com,*.cloudflare.com,argotunnel.com,*.argotunnel.com,*.trycloudflare.com' \
node scripts/prove-sandbox-preview-tunnel.mjs
```

Debug flags:

- `SANDBOX_TUNNEL_KEEP=1` keeps a passing sandbox alive.
- `SANDBOX_TUNNEL_KEEP_ON_FAIL=1` keeps a failing sandbox for manual inspection.
- `SANDBOX_TUNNEL_CLOUDFLARED_URL=<url>` overrides the binary download URL.

A passing proof means the hard product assumption is true: a sandbox process can
keep an outbound tunnel open and serve its own localhost app externally. It does
not mean production preview is complete; Autopod still needs a first-party daemon
tunnel broker, authenticated preview URLs, lifecycle cleanup, and wildcard
preview DNS/Caddy routing.

## Required Azure Setup

- Use an Entra organization identity. Personal Microsoft accounts are not supported by the preview.
- The sandbox group must live in a region where `Microsoft.App/sandboxGroups` is listed. The 2026-06-25 spike confirmed `swedencentral` and `northeurope`; `westeurope` was not listed.
- Grant the daemon identity `Container Apps SandboxGroup Data Owner` on the sandbox group, or on the resource group that contains it. This is the data-plane role used for sandbox, disk-image, exec, file, lifecycle, and egress-policy operations.
- If the daemon should create or read the sandbox group through ARM, grant normal control-plane RBAC with `Microsoft.App/sandboxGroups/read` and `Microsoft.App/sandboxGroups/write`, such as resource-group `Contributor` or `Owner`. If an admin pre-creates the group, set `AZURE_SANDBOX_ASSUME_GROUP_EXISTS=1` and grant only data-plane access.
- Create or choose a user-assigned managed identity for private image pulls. Attach it to the sandbox group and grant that identity `AcrPull` on the ACR that stores Autopod warm images. The current preview data plane still requires `registryCredentials` on disk-image creation, so Autopod mints a short-lived ACR refresh token from the daemon identity for each request instead of storing a static registry secret.
- Grant the daemon identity enough ACR rights to push and inspect warm images. In practice this means `AcrPush` plus manifest read on the registry used by `ACR_REGISTRY_URL`.

Managed identity plus short-lived token exchange is the production image-pull model. The adapter also supports explicitly provided `registryCredentials` through `AZURE_SANDBOX_REGISTRY_USERNAME` + `AZURE_SANDBOX_REGISTRY_TOKEN`; use that only for short-lived smoke tokens or emergency diagnostics, not as the steady-state auth model.

Example shape:

```bash
export AZURE_SUBSCRIPTION_ID=06bb959b-9458-41a6-bdf5-77cc12feaab9
export AZURE_RESOURCE_GROUP=ewi-sandboxes
export AZURE_SANDBOX_LOCATION=swedencentral
export AZURE_SANDBOX_GROUP=autopod-spike

az identity create \
  --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name autopod-sandbox-acr-pull

export AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID="$(
  az identity show \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name autopod-sandbox-acr-pull \
    --query id -o tsv
)"

export AZURE_SANDBOX_IMAGE_PULL_PRINCIPAL_ID="$(
  az identity show \
    --subscription "$AZURE_SUBSCRIPTION_ID" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --name autopod-sandbox-acr-pull \
    --query principalId -o tsv
)"

az role assignment create \
  --assignee "$AZURE_SANDBOX_IMAGE_PULL_PRINCIPAL_ID" \
  --role AcrPull \
  --scope "$(az acr show --name <acr-name> --query id -o tsv)"
```

## Daemon Env

Required for sandbox execution:

```bash
export AZURE_SUBSCRIPTION_ID=06bb959b-9458-41a6-bdf5-77cc12feaab9
export AZURE_RESOURCE_GROUP=ewi-sandboxes
export AZURE_SANDBOX_LOCATION=swedencentral
export AZURE_SANDBOX_GROUP=autopod-spike
export AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID=/subscriptions/.../userAssignedIdentities/autopod-sandbox-acr-pull
export ACR_REGISTRY_URL=<registry>.azurecr.io
```

Recommended:

```bash
export AZURE_SANDBOX_TIER=L
export AZURE_SANDBOX_ASSUME_GROUP_EXISTS=1
export AUTOPOD_CONTAINER_HOST=<daemon-host-reachable-from-azure-sandbox>
# Optional when containers must reach the daemon through a proxy/front door:
export AUTOPOD_MCP_BASE_URL=https://<daemon-host-reachable-from-azure-sandbox>
```

`AUTOPOD_CONTAINER_HOST` must resolve from inside the cloud sandbox. The Docker default `host.docker.internal` is not reachable from Azure. Use a Tailscale address, private endpoint, tunnel, or public DNS name that routes back to the daemon. If the container-reachable MCP URL uses a different scheme or port than the daemon bind port, set `AUTOPOD_MCP_BASE_URL` to the full base URL, for example a port-80 or port-443 reverse proxy in front of a daemon still listening on `PORT=3100`. Restricted network policy automatically allowlists the host derived from the MCP base URL.

For the hosted `ewi-sandboxes` daemon, use:

```bash
export AUTOPOD_MCP_BASE_URL=https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com
```

See `docs/hosted-daemon-tls-entra.md` for the Caddy, NSG, cert renewal, and Entra desktop-login setup.

## Warm Images

Sandbox pods do not fall back to stock base images. The pod manager requires `profile.warmImageTag`, and it must be an ACR-qualified tag such as:

```text
<registry>.azurecr.io/autopod/<profile>:latest
```

Build one with ACR configured:

```bash
export ACR_REGISTRY_URL=<registry>.azurecr.io
ap profile warm <profile> --rebuild
```

When ACR is configured, the image builder stores the ACR-qualified tag on the profile. When ACR is missing, it stores a local Docker tag; Docker pods can use that, but sandbox pods reject it before provisioning.

ACR warm-image builds force `linux/amd64`, because the Sandboxes preview rejects `linux/arm64` images even when they are otherwise valid OCI images.

Daemons with `ACR_REGISTRY_URL` configured also run a daemon-native warm-image maintenance
scheduler by default. It scans profiles after startup and every 24 hours, rebuilds missing or stale
warm images, and continues if one profile fails. The default scope is `sandbox`: profiles whose
default `executionTarget` is `sandbox`, plus any local profile that already has a warm image. Set
`AUTOPOD_WARM_IMAGE_MAINTENANCE_SCOPE=all` to keep every repo-backed profile warm, or set
`AUTOPOD_WARM_IMAGE_MAINTENANCE=false` to disable the scheduler. Override the cadence with
`AUTOPOD_WARM_IMAGE_MAINTENANCE_INTERVAL_MS`.

At sandbox pod spawn, the daemon checks:

- `profile.warmImageTag` exists.
- The tag is ACR-qualified.
- If `ACR_REGISTRY_URL` is configured, the tag exists and is readable by the daemon identity.

The sandbox data plane then proves the image can be pulled by creating the disk image with a short-lived ACR refresh token minted by the daemon identity. A failure there usually means the daemon identity lacks ACR access, the user-assigned identity is not attached to the sandbox group, or the preview API changed its registry credential shape.

## Workspace Sync

Sandboxes do not support Docker bind mounts. Autopod uses a snapshot model:

- Sync-in: configured host volumes are uploaded into the sandbox at spawn as source snapshots. For pod worktrees, `/mnt/worktree` is staging only; provisioning copies it into writable `/workspace`, matching Docker's existing overlayfs workspace flow.
- Runtime: the sandbox mutates `/workspace`, not the uploaded staging tree.
- Sync-back: `extractDirectoryFromContainer` lists runtime sandbox files recursively through the file API, reads file contents, writes into a staging directory, then mirrors staging back to the host while honoring excludes such as `node_modules` and `.autopod-*` staging directories.

This is the supported production workspace path for sandbox pods. It is not a live mount, so host edits made after spawn are not visible inside the sandbox until a future explicit resync feature exists.

## Smoke

Build the daemon, choose an existing ACR warm image, then run:

```bash
npx pnpm --filter @autopod/daemon build

export AZURE_SUBSCRIPTION_ID=06bb959b-9458-41a6-bdf5-77cc12feaab9
export AZURE_RESOURCE_GROUP=ewi-sandboxes
export AZURE_SANDBOX_LOCATION=swedencentral
export AZURE_SANDBOX_GROUP=autopod-spike
export AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID=/subscriptions/.../userAssignedIdentities/autopod-sandbox-acr-pull
export SANDBOX_IMAGE=<registry>.azurecr.io/autopod/<profile>:latest

node scripts/smoke-sandbox-adapter.mjs
```

If `AcrPull` role assignment is unavailable during a smoke, use a short-lived ACR refresh token instead of opening the registry:

```bash
export AZURE_SANDBOX_REGISTRY_USERNAME=00000000-0000-0000-0000-000000000000
export AZURE_SANDBOX_REGISTRY_TOKEN="$(az acr login --name <acr-name> --expose-token --query accessToken -o tsv)"
unset AZURE_SANDBOX_IMAGE_PULL_IDENTITY_RESOURCE_ID

node scripts/smoke-sandbox-adapter.mjs
```

The smoke creates one sandbox from the warm image, proves buffered exec, WebSocket streaming
exec (chunk arrival timing + non-zero exit code propagation — see the `exec_stream=` line),
file write/read, workspace upload into staging, copy into writable `/workspace`, workspace
sync-back, restricted egress-policy refresh, and then destroys the sandbox plus its disk image.

> **Validated live on 2026-07-08** (`ewi-sandboxes` / `swedencentral` / group `autopod-spike`,
> warm image `autopod/autopod-self:latest`). The full smoke passed: buffered exec, streaming
> exec (`exec_stream={"exitCode":7,"chunks":4,"spreadMs":3006,…}` — three 1s-spaced echoes
> arrived spread over 3s, confirming true streaming rather than a single buffered burst),
> file I/O, workspace sync-in/out, and egress refresh. The run required the caller identity to
> hold the `Container Apps SandboxGroup Data Owner` data-plane role (a `Contributor`-only login
> gets 403 on the data plane). It also surfaced and fixed a real bug: the exec-stream
> `start.command` is `execve`d literally, so `execStream()` now stages an executable wrapper
> script instead of sending a shell string (see "Exec Streaming Transport" above).

## Cleanup Checks

The manager deletes the sandbox first and then deletes the disk image it created. On daemon startup, running sandbox pods are reconciled by status and reconnected or marked killed.

To manually check for leaks:

```bash
BASE="https://management.${AZURE_SANDBOX_LOCATION}.azuredevcompute.io/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${AZURE_RESOURCE_GROUP}/sandboxGroups/${AZURE_SANDBOX_GROUP}"
API="api-version=2026-02-01-preview"

az rest --resource https://dynamicsessions.io --method get --url "$BASE/sandboxes?$API"
az rest --resource https://dynamicsessions.io --method get --url "$BASE/diskimages?$API"
```
