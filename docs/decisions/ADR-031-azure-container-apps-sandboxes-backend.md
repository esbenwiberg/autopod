# ADR-031: Azure Container Apps Sandboxes backend prototype

## Status

Proposed

## Context

Autopod needs a cloud execution target that preserves the important parts of the
Docker `ContainerManager` contract: OCI images, exec, file I/O, stop/start,
network policy, and live network-policy refresh. Azure Container Instances was
not a good fit for this shape because it lacks runtime-mutable egress policy and
does not map cleanly to Autopod's restricted network mode.

Azure Container Apps Sandboxes exposes `Microsoft.App/sandboxGroups` plus a
preview data plane. The docs and portal are Entra-gated, so we ran
`spikes/aca-sandbox/probe.py` on 2026-06-25 against subscription
`06bb959b-9458-41a6-bdf5-77cc12feaab9`, resource group `ewi-sandboxes`,
region `swedencentral`, sandbox group `autopod-spike`.

The spike confirmed:

- `swedencentral` and `northeurope` were listed; `westeurope` was not listed.
- Group create/read needs control-plane RBAC such as resource-group
  `Contributor`/`Owner`; `Container Apps SandboxGroup Data Owner` is
  data-plane only.
- OCI image provisioning works via disk image creation followed by sandbox
  creation.
- Exec works but is buffered in `azure-containerapps-sandbox==0.1.0b3`; no
  native streaming method was exposed.
- File write/read works for binary payloads.
- Directory extraction through tar + download did not produce bytes in the
  stock image and should be treated as unsupported for the prototype.
- Native egress policy is runtime mutable. Default-deny blocked `example.com`
  with `403`; after policy mutation the same request returned `200`.
- Stop/resume works and maps to `begin_stop()` / `begin_resume()`.

## Decision

Implement a feature-flagged `executionTarget: 'sandbox'` backend using Azure
Container Apps Sandboxes.

The daemon activates the backend only when `AZURE_SUBSCRIPTION_ID` and
`AZURE_RESOURCE_GROUP` are set. It defaults to `swedencentral` and
`autopod-spike`, with overrides:

- `AZURE_SANDBOX_LOCATION` or `AZURE_LOCATION`
- `AZURE_SANDBOX_GROUP` or `SANDBOX_GROUP`
- `AZURE_SANDBOX_ASSUME_GROUP_EXISTS=1`
- `AZURE_SANDBOX_TIER`

`SandboxContainerManager` remains the `ContainerManager` implementation and
keeps Azure-specific HTTP behind `SandboxApiClient`. It supports spawn, kill,
buffered exec, streaming fallback, read/write file APIs, stop/start, and
`refreshFirewall()` through native egress-policy replacement.

For restricted network policy, reuse Autopod's existing allowlist calculation
including defaults, profile hosts, MCP server hosts, private registries, and the
daemon MCP host from `mcpBaseUrl`. Docker continues to enforce the same policy
with iptables/HAProxy; Sandboxes uses native `defaultAction` + `hostRules`.

Because Sandboxes do not support Docker bind mounts, the prototype uploads
configured host volumes at spawn. Sync-back is explicitly not solved in this
ADR. `extractDirectoryFromContainer` throws a clear unsupported error until a
durable sync-back design exists.

## Consequences

Easier:

- Autopod gets a cloud backend with native runtime-mutable egress policy.
- `refreshFirewall()` works for sandbox profiles without the Docker
  iptables/HAProxy machinery.
- Stop/resume maps to platform lifecycle rather than full teardown.
- The backend stays opt-in and does not alter Docker behavior.

Harder:

- Exec is buffered, so live terminal UX is weaker than Docker until the preview
  SDK adds streaming.
- Volume upload at spawn can be expensive and does not handle sync-back.
- The daemon needs a reachable `AUTOPOD_CONTAINER_HOST` for cloud sandboxes to
  call the MCP endpoint.
- Preview API shape may drift; the adapter must stay covered by request-shape
  tests and live smoke checks.

Committed to:

- No automatic rerouting from Docker to Sandboxes.
- No desktop polish in the backend prototype.
- No claim of production sync-back until directory extraction or another
  durable workspace return path exists.
- Treat `westeurope` as unsupported unless provider registration later lists it.

## Alternatives rejected

- **Keep ACI as the cloud backend.** It does not provide the runtime egress
  mutation that makes restricted mode viable.
- **Use only the Python SDK from the daemon.** Shelling out would make auth,
  streaming, retries, and tests harder than keeping a TypeScript adapter behind
  `SandboxApiClient`.
- **Pretend bind mounts exist.** They do not. Upload-at-spawn is honest for a
  prototype; sync-back needs a separate design.
- **Mark extraction as best-effort.** The live spike showed no usable bytes from
  the tar download path, so the container manager should fail explicitly.
