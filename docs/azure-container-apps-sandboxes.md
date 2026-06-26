# Azure Container Apps Sandboxes

Autopod can run `executionTarget: sandbox` pods in Azure Container Apps Sandboxes.
This target is production-supported only with Autopod warm images published to ACR.

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
export AUTOPOD_MCP_BASE_URL=http://<daemon-host-reachable-from-azure-sandbox>
```

`AUTOPOD_CONTAINER_HOST` must resolve from inside the cloud sandbox. The Docker default `host.docker.internal` is not reachable from Azure. Use a Tailscale address, private endpoint, tunnel, or public DNS name that routes back to the daemon. If the container-reachable MCP URL uses a different scheme or port than the daemon bind port, set `AUTOPOD_MCP_BASE_URL` to the full base URL, for example a port-80 or port-443 reverse proxy in front of a daemon still listening on `PORT=3100`. Restricted network policy automatically allowlists the host derived from the MCP base URL.

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

The smoke creates one sandbox from the warm image, proves exec, file write/read, workspace upload into staging, copy into writable `/workspace`, workspace sync-back, restricted egress-policy refresh, and then destroys the sandbox plus its disk image.

## Cleanup Checks

The manager deletes the sandbox first and then deletes the disk image it created. On daemon startup, running sandbox pods are reconciled by status and reconnected or marked killed.

To manually check for leaks:

```bash
BASE="https://management.${AZURE_SANDBOX_LOCATION}.azuredevcompute.io/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${AZURE_RESOURCE_GROUP}/sandboxGroups/${AZURE_SANDBOX_GROUP}"
API="api-version=2026-02-01-preview"

az rest --resource https://dynamicsessions.io --method get --url "$BASE/sandboxes?$API"
az rest --resource https://dynamicsessions.io --method get --url "$BASE/diskimages?$API"
```
