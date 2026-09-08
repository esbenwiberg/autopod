# Bounded managed provider composition

This library is local code, not an enabled native daemon configuration. The deployed
CLI lane remains dark. `composeDarkManagedCli` is unchanged; migrations 151/152 and the
new provider modules have not been deployed. Importing `dist/managed.js` does not
start a listener, discover credentials, select an account or launch a worker.

`composeManagedRuntime` connects independent pinned Git copies, verified artifact
input mounts, `ManagedContainerRuntime`, `ManagedQuotaFeed`, the durable provider
gateway and the artifact/control pipeline. It requires an explicit reviewed
`ManagedWorkerProviderChannel` and container manager for each exact route. The
channel is a trusted host integration port: it must prove that the selected worker
command can use only its attempt-bound callback and cannot reach a direct provider.
The concrete report-only `ContainerCodexChannel` implements this port for Codex.
The installed CLI has consumed its loopback protocol with a deterministic provider;
that evidence is separate from the fixture composition tests.
Sandbox managers upload the prepared volumes; actual read-only DAC, network,
image-pull and lifecycle enforcement still require target acceptance.

The callback captures installation, pod, grant revision and provider route; the
worker supplies only an operation key, bounded text and token reservation. Default
maximum is one generation operation per pod. Journal migration 151 persists a
request/transport/policy digest before quota reservation. A reserved or uncertain
operation is never retried, even after a crash between journal and allowance
writes. Observed output is replayed only under current unrevoked authority. A
changed key cannot bypass the operation ceiling; changed bindings or request
limits cannot reuse a journal under a different policy. Prompt text and credentials
are not stored in the journal; bounded successful response text is stored for replay.

The existing supervisor counts reservations toward exhaustion. A gateway request
must leave at least one token of unreserved grant headroom; this is checked before
journal writes or provider effects. A 4,096-token grant can reserve at most 4,095
for a call. Uncertain calls retain their full reservation. Pending calls are
aborted on revocation, expiry, revision changes or composition shutdown; the
transport checks authority between input counting and generation and before
returning output. Abort does not prove remote generation stopped, so its reservation
is retained. The provider's output cap independently bounds an accepted request.

## Reference API transport

`BoundedResponsesTransport` supports an explicitly supplied API-key credential
resolver only. It pins the account label, exact route and API origin, forbids
redirects/retries, sends text with no tools or inherited conversation, counts input
and sets `max_output_tokens` to the remainder of the reservation. It validates
completed response model, usage and size before returning assistant text; reasoning
items are ignored, tool calls and incomplete/invalid results are refused. All
provider/network/auth error bodies are redacted. Credentials remain in host memory.
The credential resolver is trusted host configuration and must actually resolve
the enrolled account; string equality is not independent provider identity proof.

One generation uses two HTTP requests: input-token counting, then Responses creation.
This is not acceptance of a proposal capped at one provider HTTP request. It is not
a drop-in replacement for the native ChatGPT-backed Codex runtime. Live model
availability, token-count parity and account identity remain untested.

The API input counter is documented at
https://developers.openai.com/api/reference/cli/resources/responses/subresources/input_tokens/methods/count
and the output cap, including reasoning tokens, at
https://developers.openai.com/api/reference/cli/resources/responses/methods/create.
No equivalent verified hard total-token-cap contract is established here for
ChatGPT authentication. `chatgpt` therefore fails preflight before credential
resolution or network access. There is no API-account or runtime fallback.

## Explicit request/time ChatGPT transport

The owner approved an additive `RequestTimeBudget`: `mode: request-time`, one
provider HTTP request, at most 180 seconds and absolute expiry. `Budget` also keeps
the original hard-token shape unchanged. Profile and effective grant modes must
match. Controls require a new attempt for any budget change. Dispatcher requires
`request-time-budget-v1`; older producers cannot silently accept the new mode.

`ChatGptReportTransport` resolves only the exact enrolled ChatGPT account in host
memory and performs one POST to the existing native Codex backend origin. It uses
streamed Responses with no retry, redirect, input-count request or fallback.
Messages are normalized through the report-only codec. The completed response must
contain exact model, valid usage and only bounded assistant text/reasoning.
Credentials, HTTP failures and provider error bodies are never returned to callers.
The backend contract is locally tested and still requires real provider acceptance.

Migration 152 adds nullable `actual_tokens` to the request journal. In this mode,
zero is used only as the internal no-token-reservation sentinel; no token allowance
is allocated. Unknown usage remains NULL with a reserved journal entry and
`tokenUsageKnown: false`. A validated response records measured usage, which may
exceed 4,096; neither its tokens nor the worker deadline are a hard financial cap.
The durable claim enforces the single request across concurrency/restart/replay.
Fresh authority is required before any delivery, including cached responses.

The existing hard-token API transport and allowance broker remain unchanged in
meaning; they reject request/time transport substitution. The worker supervisor
still enforces expiry and stale/revoked quota leases in both modes. Request/time
mode alone does not stop based on token count. Abort never proves remote generation
ceased. An uncertain request is never retried or replaced.

## Deployment boundary

Budget policy is approved. Local schema 152 and the concrete channel/transport are
not deployed. An automatic approval-review block currently prevents reading the
existing Sandbox target identifiers. After that exact read is authorized, bind the
actual target, stage the immutable release/repository, prove the image's CLI and
OS/network enforcement and run the single canary. Preserve native configuration,
rows and active work. The report-only fixture is not general coding acceptance.

## Concrete report-only Codex channel

`ContainerCodexChannel` installs a root-owned loopback server and a credential-free
worker helper in the attempt container. The selected manager must enforce denied
external egress, empty worker identity bindings and a read-only frozen repository.
The reviewed command builder reads that repository's README and writes only the
report artifact. Source-delivery modes are rejected. A fresh child home and cwd
avoid inherited account, user and repository configuration. Required CLI flags are
checked against the actual selected image before installation.

The server serializes requests into a private root spool; only trusted host exec
can read it and deliver a gateway result. Every HTTP delivery gets a fresh ticket,
including identical retries, and must recheck current database authority. Changed
requests, worker Authorization headers, alternate models, tools in provider output,
oversized data and ambiguous journal states fail closed. The selected container
must run the worker unprivileged; the local macOS fixture does not prove Linux DAC.

`codex-wire.ts` accepts the observed Responses request shape and normalizes it to
fresh text messages, exact model/reasoning, no tools and no prior conversation.
Codex advertises tools both at top level and as `additional_tools` input records;
those declarations are removed before provider counting/generation. Assistant text
and validated usage are serialized into SSE. Channel IDs are deterministic local
representation IDs, not upstream provider receipt IDs. The report worker is not a
general coding/tool-use adapter. Its first canary profile must bind the reviewed
README command, read-only enrollment and `/output/report.md` artifact policy.

Run the explicit `src/test-utils/codex-channel-acceptance.ts` harness against a
bundled entrypoint to exercise installed Codex 0.152.1 with an empty home and fake
in-process provider. It verifies output, replay without regeneration, changed-body
and Authorization rejection, and revoked replay. Fake token usage is explicitly
fixture data. The immutable Sandbox image's CLI version and behavior remain
unaccepted; the locally installed CLI version does not establish image parity.

This adds no normal voice turn, approval, interruption or spoken implementation
concept. Existing numeric budgets apply: one turn to launch, zero clarification,
repeated approval or routine interruption, at most 35 launch and 45 completion words.
