# Managed execution with local Docker

The reviewed profile-set composition now accepts `local` as well as `sandbox`.
All profiles in one configured set use the same target. Local execution uses the
existing Docker manager, supervisor, account-bound provider channel, immutable
repository revision, artifact contracts, and Entra user-to-installation bindings.
No extra launch question or approval is added.

## Configuration

Build the local worker image from the repository root:

```sh
docker build -f templates/managed/Dockerfile.codex-local -t autopod-managed-local:reviewed templates/managed
docker image inspect autopod-managed-local:reviewed --format '{{.Id}}'
```

Use that immutable `sha256:…` image ID in `AUTOPOD_MANAGED_PROFILE_SET.image`.
Registry `repository@sha256:…` references also work. Mutable tags are rejected.
A sandbox profile still requires a registry digest. The image includes Python,
Git, the firewall utilities and Codex CLI 0.160.1. A build's resulting image ID,
rather than its mutable tag, is the execution binding.

Set each reviewed profile's `route.executionTarget` to `local` and recompute the
snapshot/request digests. The rest of the existing profile-set contract applies:
exact enrolled repository revision, provider account, model, reasoning, task kind,
input names, output paths, source policy and request/time budget. Local mode does
not infer a provider account or copy credentials from the host.

`AUTOPOD_MANAGED_CLI` accepts exactly one artifact backend. For local persistence,
replace `blobContainerUrl` with an absolute `artifactDirectory`:

```json
{
  "bindings": [{
    "issuer": "https://login.microsoftonline.com/TENANT/v2.0",
    "audience": "api://APPLICATION",
    "objectId": "USER_OBJECT_ID",
    "installationId": "dispatcher-local"
  }],
  "artifactDirectory": "/absolute/daemon-owned/artifacts"
}
```

Use the actual token issuer/audience and reviewed user identity. Existing Entra
validation remains required; the development token cannot enable managed routes.
The artifact directory is private to the daemon and never mounted in workers.
Writes publish atomically, reject conflicting contents and survive restart.
The existing Azure Blob configuration remains supported unchanged.

The Docker socket must be available to the daemon. Each job gets a private bridge;
its effective scope generates the firewall without an implicit daemon/host gateway
allowance. Trusted root setup can prepare mount ownership and reap the worker
process group. Worker processes run as uid 1000 with no effective capabilities and
no-new-privileges. Cleanup removes the container before its network. Local source
freezing uses the existing bind-mounted worktree rather than copying it over itself.

## Executed validation and remaining boundaries

On 2026-10-07 the opt-in Docker suite exercised real HTTP, SQLite, Docker, the
installed Codex CLI and its loopback provider channel with a controlled provider
response. It covered completed report publication, duplicate start, request-count
limits, blocked direct egress, read-only repository mounts, zero worker effective
capabilities, cancellation, daemon-component/database restart, authenticated
artifact download and cleanup replay. The file store also has concurrent-write,
immutable-conflict and restart coverage.

Run it using the reviewed image ID and your Docker socket:

```sh
AUTOPOD_MANAGED_DOCKER_IMAGE=sha256:IMAGE_ID \
AUTOPOD_MANAGED_DOCKER_SOCKET=/path/to/docker.sock \
npx pnpm --filter @autopod/daemon exec vitest run src/managed/local-runtime.docker.test.ts
```

The suite makes no external model request and does not prove Entra login, hosted
sandbox allocation, live model acceptance, source publication or voice-device
acceptance. The development daemon remains usable for ordinary local API checks;
a reviewed managed profile and authenticated user/provider configuration are still
needed before running live managed jobs. Uncertain allocation remains visible and
cannot be declared cleaned merely because no runtime identity was recorded.

Voice-path impact: inherited limits remain one turn to launch, at most one material
clarification, zero additional approvals or interruptions, and no additional spoken
response. These changes prevent stuck completion, false cleanup failure, artifact
loss on restart and misleading connection errors through internal mechanisms.

## Local Codex confinement

The trusted local route selects the outer container as Codex's sandbox. The
worker runs Codex with `danger-full-access` inside that container, because its
bubblewrap mount namespace cannot start under the existing seccomp policy.
This does not add container privileges or network access. Read-only repository
and artifact mounts, denied external egress, uid 1000, zero effective worker
capabilities and no-new-privileges remain the enforcement boundary. Sandbox
routes retain their existing nested Codex mode. This selection is internal and
adds no voice question or approval.

The opt-in `src/managed/live-rpi.docker.test.ts` checks real-model research,
planning and implementation with frozen artifact inputs and an independent
oracle against the resulting Git bundle. It requires an explicit local Codex
auth file, model, local canary repository and immutable Docker image through
`AUTOPOD_MANAGED_LIVE_AUTH_FILE`, `AUTOPOD_MANAGED_LIVE_MODEL`,
`AUTOPOD_MANAGED_LIVE_REPOSITORY`, and `AUTOPOD_MANAGED_DOCKER_IMAGE`.
Credentials remain in the host transport. HTTP authentication in this test is
controlled; it does not prove Entra login, Dispatcher scheduling, Azure execution
or GitHub delivery. Set `AUTOPOD_MANAGED_LIVE_REPORT` to retain its result.
Run it separately from CPU-heavy suites; an unresponsive Docker API is a failed
or incomplete run, never acceptance evidence.

Large local provider responses use root-owned staged chunks below Linux's
per-argument exec limit, then verify the active request ticket before atomic
publication. Ordinary worker-owned file upload is deliberately avoided for this
private control directory. The Docker test carries an SSE response above one MiB
and checks that the worker cannot read the response spool. Channel failures retain
only a fixed phase/category, never the provider payload or credential.
