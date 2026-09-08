# Managed Dispatcher execution v1

The owned AutoPod daemon runs on the existing Azure VM. This lane is subordinate:
one Dispatcher attempt maps to one managed pod. It never enters native queue,
series, fallback, notification, merge, deployment or publication paths. There is
no Pi dependency. Importing `@autopod/daemon/managed` starts no listener.

The Dispatcher integration plan remains the sequencing authority:
`dispatcher/docs/plans/autopod-dispatcher-integration.md`. Producer/consumer
`protocol.schema.json` and `examples.json` are byte-identical. Build handshake 1
requires the capabilities used by the exact request. The lane is disabled by
default; schema tests never authorize enablement.

## Composition

Use the exported `createManagedServer` factory with an already migrated database,
reviewed admission/profile snapshots, a `ManagedContainerRuntime`, one private
`AzureBlobArtifactStore`, a private state root and explicit TLS material. It
returns the app without calling `listen`. New starts stay disabled unless
`enabled` is explicitly selected after the applicable acceptance gates.

- mTLS CA validation plus a pinned certificate fingerprint map identifies the
  Dispatcher installation. Body fields or forwarded headers do not establish identity.
  Native user/pod-token authentication is unchanged on the existing server.
- `ManagedWorkspaces` makes an independent copy of an exact enrolled local mirror,
  with no shared Git metadata/hardlinks or inherited remote. It never edits that
  mirror. Provision correct worker UID/GID access as part of the reviewed boundary.
- Compose its mounts with `service.inputs.mounts(podId)`, the exact network policy
  and the reviewed image/command. The command must accept its final objective
  as positional data following `--`; it cannot interpret that text as model flags. Docker enforces read-only mounts; Sandbox uploads
  enforce root ownership and read-only DAC under the unprivileged supervised worker.
- `quotaReady` must check the real account gateway's concrete allowance enforcement.
  `ManagedQuotaBroker.invoke` reserves worst-case tokens before the exact account
  call. `ManagedQuotaFeed.attach` writes a root-owned receipt every second through
  trusted exec. A stale/unavailable feed stops the worker independently of Dispatcher.
  Do not substitute a readiness Boolean for a verified gateway in production.
- Source delivery uses `ManagedGitBroker` and optionally `GitHubDraftBroker`.
  Reusable credentials never enter workers, specs, databases or receipts. The Git
  broker accepts an injected short-lived account credential, uses a fresh Git
  repository from the frozen bundle and disables redirects. The draft broker uses
  an injected installation-token resolver and an exact body-digest resolver.
- The managed supervisor asset and migrations 142–150 are included in the build.
  Existing native rows are preserved. Import `dist/managed.js` to compose the lane;
  `dist/index.js` remains the existing native entry.

## API

All routes require the authenticated installation. Artifact reads also enforce ownership.

| Method | Path | Purpose |
|---|---|---|
| GET | `/managed/health` | Passive build/capability discovery |
| POST | `/managed/preflight` | Exact grant, route, profile and enforcement admission |
| POST | `/managed/pods` | Idempotent managed start |
| POST | `/managed/reconcile-start` | Recover the original pod identity |
| GET | `/managed/pods/:podId/events?cursor=...` | Durable events and result, without waking the agent |
| POST | `/managed/pods/:podId/send/:key` | Bound idempotent follow-up |
| POST | `/managed/pods/:podId/control/:key` | Revoke, stop or observed cleanup |
| POST | `/managed/pods/:podId/grant/:key` | Monotonic revision; scope/budget changes need a new attempt |
| GET | `/managed/pods/:podId/candidate/bundle` | Frozen candidate bytes, maximum 64 MiB |
| POST | `/managed/pods/:podId/finalize` | Verified, idempotent source effects |
| GET | `/artifacts/:artifactId` | Committed receipt |
| GET | `/artifacts/:artifactId/manifest` | Immutable manifest |
| POST | `/artifacts/:artifactId/download` | Private digest-checked bundle |

Stop acceptance, observed worker exit and observed cleanup are distinct facts.
Cleanup waits for required artifact exports and any promised source candidate to
be frozen. Source delivery can then recover without the worker or its workspace.
An uncertain Sandbox create never allocates a replacement. Suspension is not exit.
A missing authoritative PR result never authorizes creating another PR.

## Local checks and remaining acceptance

Run shared build/tests first, then from `packages/daemon` run:

```
./node_modules/.bin/tsc --noEmit -p tsconfig.managed.json
./node_modules/.bin/vitest run --maxWorkers=4
./node_modules/.bin/tsup
```

Dispatcher retains the complete cross-language fixtures, automated transcripts,
validation summary and producer review patch under `docs/implementation`.

Live acceptance is **BLOCKED / not run**: authorize a dark deployment to the
existing VM; configure reviewed service identity/private Blob roles; verify the
handshake; then authorize one selected test enrollment/account for research,
handoff, source and Sandbox canaries. Verify GitHub conditional draft-body updates
before granting that effect. Provider use, credentials, deployment, GitHub and
voice/device/human acceptance require their own explicit authorization and receipts.
