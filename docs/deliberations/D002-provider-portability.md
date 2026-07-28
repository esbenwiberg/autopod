# D002: Fast, safe model-provider portability

## Question

How should Autopod make a newly attractive model provider usable quickly—starting with OpenCode Zen, OpenCode Go, Kimi Code membership, or Kimi API—without adding another brittle provider-specific path across daemon, CLI, desktop, runtime, credentials, and analytics?

## Current thesis

Make **Pi the default portability runtime** and add a **manifest-driven provider registry** for API-accessible providers. Do not add a Zen, Go, or Kimi Autopod runtime: a runtime is the coding-agent implementation, while these offerings are model backends, billing products, and authentication authorities.

A provider manifest must be richer than “OpenAI-compatible base URL.” It should identify:

- provider/product identity and human-readable policy metadata;
- supported authentication kind and credential ownership;
- network hosts and privacy/retention posture;
- a curated model catalog where each model selects its protocol/API surface and declares capabilities, context/output limits, compatibility flags, and pricing/usage semantics;
- lifecycle status such as experimental, supported, deprecated, or blocked;
- whether unattended use has been verified or still requires explicit human acceptance.

For static API-key providers whose models fit Pi's supported APIs, onboarding should be data plus conformance tests rather than new runtime code. OAuth, dynamic catalogs, or non-standard streaming should remain an escape hatch implemented as a trusted Pi provider extension. Existing Claude, Codex, Copilot, MAX, Foundry, and other bespoke paths should not be rewritten before the generic path proves itself.

## Desired gain

Observable success means:

- a new static-key provider with supported Pi protocols can be added in one curated manifest plus provider conformance fixtures, without changing runtime types or duplicating provider lists through all UI layers;
- a profile can link a shared provider account, select a provider-qualified model, and launch it through Pi while secrets remain encrypted at rest and absent from inspectable process environments;
- protocol and compatibility are selected per model, not guessed from a provider-wide “compatible” label;
- restricted-network pods automatically admit only the selected provider's declared hosts;
- provider/model deprecation, privacy, quota, and authorization caveats are visible and auditable;
- unsupported capabilities fail during configuration or a preflight probe rather than halfway through an autonomous pod;
- bespoke provider code is required only for genuinely bespoke auth, discovery, or transport behavior.

A practical benchmark is that Zen, Go, Kimi Code, and Kimi API can each be assessed and, where authorized, enabled without adding four new `RuntimeType` values or four branches to `buildProviderEnv()`.

## Context and evidence

### Repository architecture

- `packages/shared/src/types/runtime.ts` defines runtimes as agent implementations: `claude`, `codex`, `copilot`, and `pi`.
- ADR-033 (`docs/decisions/ADR-033-autopod-native-pi-worker.md`) explicitly establishes Pi as the provider-neutral Autopod worker while retaining vendor runtimes where subscription behavior is preferable.
- `packages/daemon/src/runtimes/pi-runtime.ts` already runs Pi through a managed RPC worker and preserves Autopod's MCP policy boundary.
- Provider extensibility is currently closed and duplicated. `ModelProvider`, `ProviderCredentials`, profile schemas, provider-account schemas, runtime resolution, environment construction, network defaults, CLI auth commands, desktop enums/pickers/authentication switches, and analytics all carry hard-coded inventories.
- `packages/daemon/src/providers/env-builder.ts` is an exhaustive provider switch containing auth injection, runtime compatibility, provider-specific files, and persistence behavior in one module.
- `packages/daemon/src/pods/runtime-resolver.ts` currently conflates backend protocol with runtime selection: OpenAI-surface providers force Codex, while Pi has a separate compatibility allowlist.
- `packages/daemon/src/pods/runtime-network-defaults.ts` only knows Codex/ChatGPT hosts; generic providers need provider-qualified network defaults.
- `packages/daemon/src/providers/llm-client.ts` is Anthropic-SDK-specific, so daemon-side review/title helpers do not automatically follow a newly configured Pi provider.
- The native Pi feature required changes across more than 80 files, but most of that blast radius came from adding a runtime. Backend providers should not pay that cost.

### Pi provider boundary

- Pi has built-in providers for OpenCode Zen (`opencode`), OpenCode Go (`opencode-go`), and Kimi For Coding (`kimi-coding`), with API-key credentials in `~/.pi/agent/auth.json` (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md`).
- Pi's `models.json` supports per-model `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai` APIs, along with compatibility flags for reasoning, tool schemas, replay, cache behavior, and streaming (`docs/models.md` in the installed Pi package).
- Trusted Pi extensions can register complete providers with custom OAuth, model refresh/filtering, or stream implementations through `pi.registerProvider()` (`docs/custom-provider.md`).
- Therefore Autopod can provision provider credentials/catalog data into the existing Pi runtime. It does not need a provider-specific Autopod stream parser for these offerings.
- Autopod's managed Pi startup disables executable project resources, so any provider extension must be an Autopod-owned, pinned package or trusted image resource—not repository-supplied code.

### OpenCode Zen and Go

- Zen is pay-as-you-go and explicitly allows use with other coding agents. Go is a low-cost subscription and exposes raw API endpoints, but its documentation is less explicit about arbitrary third-party unattended agents.
- Both use static API keys from the OpenCode console.
- Zen and Go are multi-protocol gateways. Models are individually routed through OpenAI Responses, OpenAI Chat Completions, Anthropic Messages, or Google-native endpoints. A single provider-wide API surface is incorrect.
- Go applies rolling five-hour, weekly, and monthly dollar-value limits. Optional Zen-balance fallback can turn quota exhaustion into pay-as-you-go spend.
- Their model catalogs and pricing change, and the `/models` response does not appear sufficient by itself to recover protocol, compatibility, privacy, and cost metadata safely.
- OpenCode's current hosted-service terms contain language that appears to conflict with unattended/programmatic output extraction despite Zen's “any coding agent” statement. Written clarification is a gate for presenting unattended Autopod usage as supported.

Primary sources: <https://opencode.ai/docs/zen/>, <https://opencode.ai/docs/go/>, and <https://opencode.ai/legal/terms-of-service>.

### Kimi products

- Kimi Code membership and Kimi Open Platform API are separate products with non-interchangeable credentials and billing semantics.
- Kimi Code exposes static API keys and both OpenAI-compatible (`https://api.kimi.com/coding/v1`) and Anthropic-compatible (`https://api.kimi.com/coding/`) surfaces. Current stable model IDs include `k3`, `kimi-for-coding`, and `kimi-for-coding-highspeed`.
- Kimi Code documentation advertises third-party coding tools, but one help page says benefits are only supported in named tools and warns that unauthorized clients may lead to restricted access. Autopod authorization therefore needs confirmation rather than inference from technical compatibility.
- Kimi API is a pay-as-you-go, OpenAI-compatible server-side API and is the clearest unattended integration candidate.
- Kimi behavior is model-specific: reasoning fields and replay requirements, tool-choice restrictions, minimum output-token guidance, stream completion semantics, and context windows cannot safely be represented by a bare endpoint and model ID.
- Pi already exposes Kimi-oriented compatibility behavior, including Kimi deferred tools and reasoning-content replay flags, making Pi the stronger abstraction boundary than Codex CLI environment overrides.

Primary sources: <https://www.kimi.com/help/kimi-code/third-party-agents>, <https://www.kimi.com/code/docs/en/kimi-code/models.html>, and <https://platform.moonshot.ai/docs/>.

## Boundaries and authority

- Do not add a new Autopod runtime for a backend that Pi can call through a supported provider API.
- Do not promise that “OpenAI-compatible” means tools, streaming, reasoning, replay, or accounting are portable.
- Do not auto-discover and enable arbitrary models without curated capability and policy metadata.
- Do not execute repository-provided provider extensions in managed pods.
- Do not put raw API keys in profile JSON, generated `models.json`, process environment variables, logs, or Docker inspection output. Continue encrypted-at-rest provider accounts and secret-file injection; generated Pi auth may refer to a trusted secret-file reader.
- Do not allow arbitrary custom base URLs without SSRF validation, network-policy integration, and an explicit trust boundary.
- Do not silently turn subscription exhaustion into metered fallback spend.
- Do not claim provider-supported unattended operation where official terms or tool allowlists are ambiguous. Human acceptance or provider clarification is required.
- Do not migrate existing provider/runtime paths until the generic API-provider path proves operational parity.
- Human approval remains required before implementation dispatch, provider terms acceptance, material spend-policy changes, or enabling a provider for sensitive repositories.

## Pressure log

### Round 1 — incumbent architecture and external offering landscape

**Pressure applied and why it could change the thesis**

Investigated Autopod's runtime, provider, credential, network, profile, CLI, desktop, and analytics surfaces alongside official Zen, Go, and Kimi product/API documentation. If these products required new coding-agent CLIs or if Autopod already had an open backend contract, the direction would differ.

**Evidence**

- Autopod already has a provider-neutral Pi runtime, but provider identity and credentials remain closed discriminated unions and repeated UI switches.
- Zen, Go, Kimi Code, and Kimi API all expose callable APIs; none inherently requires a new Autopod runtime.
- Zen/Go and Kimi route models through different protocol/compatibility behaviors.
- Subscription, pay-as-you-go, quota fallback, privacy, and client-authorization semantics differ even when endpoints look compatible.

**What survived**

- Provider portability is timely and valuable.
- Shared provider accounts and Pi are strong foundations.
- Zen/Go/Kimi are useful forcing functions for a general boundary rather than one-off additions.

**What changed**

- The target is no longer “support another runtime/provider.” It is “separate runtime, provider product, API surface, model capabilities, and auth authority.”
- Generic support cannot mean forwarding arbitrary OpenAI-compatible requests.
- Terms/privacy/spend metadata are part of readiness, not documentation afterthoughts.

**New unknowns**

- Whether provider manifests should live as compiled repository data, daemon-managed signed data, or trusted Pi provider packages.
- How much of the existing provider discriminated union should be replaced versus wrapped by one generic API-provider credential variant.
- Whether daemon-side LLM helpers should become Pi-backed or remain best-effort/provider-limited initially.

### Round 2 — Pi provider-extension capability investigation

**Pressure applied and why it could change the thesis**

Inspected Pi's complete custom-model and custom-provider contracts. If Pi only supported global base-URL overrides, Autopod would need its own transport adapter layer; if Pi already expressed model-level protocols and quirks, duplicating that layer would be harmful.

**Evidence**

- Pi ships built-in Zen, Go, and Kimi Coding provider catalogs and auth keys.
- Pi supports per-model protocol choice, compatibility flags, model limits/costs, API-key auth, OAuth, dynamic refresh, and fully custom streaming.
- Pi auth supports API-key entries and trusted command resolution, while Autopod already writes Pi auth state into the container and reads rotated auth back.
- Autopod managed mode can continue to block project extensions while loading only an Autopod-owned provider package/config.

**What survived**

- Pi should own provider wire behavior and agent-session compatibility.
- Autopod should own provider-account custody, policy, eligibility, network admission, lifecycle, and user-facing configuration.

**What changed**

- A broad Autopod provider plugin API is probably unnecessary for the first boundary.
- Static providers may need no Autopod provider code at all beyond a manifest/account mapping; complex providers can use a pinned trusted Pi extension rather than a new runtime.
- Built-in Pi provider IDs provide an immediate low-risk path for Zen, Go, and Kimi Code once authorization and credential injection are settled.

**New unknowns**

- The smallest durable manifest schema and ownership boundary.
- Whether to consume Pi's built-in catalog directly or pin an Autopod-reviewed subset to prevent silent provider/model changes.
- Whether one generic API-key credential variant creates acceptable migration and redaction behavior in existing profile/provider-account APIs.

### Round 3 — architecture council on the provider extension unit

**Pressure applied and why it could change the thesis**

Compared the incumbent hard-coded paths, compiled manifests, a remotely mutable daemon registry, and pinned Pi provider packages across onboarding speed, security/determinism, protocol fidelity, and maintenance. The first two attempted worker adapters failed before producing evidence; the valid round used four independent bounded research workers with a shared repository scout. If one extension unit dominated all axes, the hybrid thesis would be unnecessary.

**Evidence**

- Pinned Pi packages ranked highest for onboarding velocity, protocol fidelity, and change isolation because they can own custom auth, discovery, and streaming behavior.
- Compiled manifests ranked highest for deterministic operation, reviewability, and secret/supply-chain containment because they are declarative and tied to an Autopod release.
- A remotely mutable registry improved catalog-update speed but ranked worst on reproducibility and cross-version compatibility unless snapshots are signed, content-addressed, approved, and pinned—in which case it becomes distribution for compiled state rather than live authority.
- The incumbent retained some security value through closed schemas and explicit secret handling, but its scattered change surface did not justify preserving it for generic API providers.

**What survived**

- Compiled curated manifests should be the ordinary path.
- Pinned trusted Pi provider packages should remain the escape hatch for behavior that manifests cannot express.
- Existing bespoke runtime/provider integrations should remain additive during rollout.

**What changed**

- A remote registry is not part of the initial execution authority. Future remote distribution may suggest updates, but a pod should run against a reviewed, pinned snapshot.
- Pi packages should not be the default extension unit for static providers because executable code needlessly expands the secret and supply-chain boundary.
- The design is explicitly two-tiered: declarative first, trusted executable adapter only when required.

**New unknowns**

- Whether a concrete Zen/Go/Kimi onboarding specimen fits the declarative tier without hidden provider-specific code.
- The exact generic credential and provider/model reference shapes needed to stop UI and schema duplication.

### Round 4 — concrete Zen, Go, Kimi Code, and Kimi API onboarding specimen

**Pressure applied and why it could change the thesis**

Mapped each target offering through the installed pinned Pi provider implementation, Autopod provider-account storage/redaction, Pi auth injection, profile model selection, desktop provider creation, and network defaults. If any target required its own Autopod runtime/parser or bespoke static-key flow, the declarative-first thesis would fail.

**Evidence**

- The pinned Pi distribution already includes native providers `opencode`, `opencode-go`, `kimi-coding`, and `moonshotai`.
- Pi's Zen and Go providers expose multiple APIs in one provider and their pinned catalogs select protocol and compatibility per model.
- Pi's Kimi Code provider supports both API-key auth and OAuth; its catalog supplies required `User-Agent`, adaptive-thinking, empty-signature, model-limit, and reasoning-level metadata.
- Pi's Moonshot provider supplies Kimi API models with OpenAI-completions compatibility, including reasoning-content replay and Kimi deferred-tool behavior where needed.
- Autopod provider accounts already encrypt arbitrary credential JSON at rest and redact public responses, but their provider identity and credential shape are closed and conflated (`provider-account-store.ts`, `provider-account-redaction.ts`, and shared provider schemas).
- A static-key pod can generate Pi auth shaped as `{ "<piProviderId>": { "type": "api_key", "key": "!cat /run/autopod/model-provider-key" } }` while writing the actual key as a restricted secret file. Static keys need no auth readback persistence.
- Desktop account creation and Pi model choices are hard-coded arrays. A daemon endpoint derived from compiled manifests must replace those lists; otherwise every new provider still requires desktop code.
- Restricted network admission must come from the selected manifest (`opencode.ai`, `api.kimi.com`, or `api.moonshot.ai`) rather than runtime-wide ChatGPT defaults.

**Concrete specimen**

| Product | Pi provider | Example model reference | Auth tier | Required host | Launch gate |
| --- | --- | --- | --- | --- | --- |
| OpenCode Zen | `opencode` | `opencode/kimi-k2.7-code` | generic API key | `opencode.ai` | resolve unattended-use terms ambiguity |
| OpenCode Go | `opencode-go` | `opencode-go/kimi-k3` | generic API key | `opencode.ai` | resolve third-party/unattended authorization and expose metered fallback policy |
| Kimi Code | `kimi-coding` | `kimi-coding/kimi-for-coding` | generic API key; OAuth is bespoke | `api.kimi.com` | confirm Autopod is an authorized third-party client and preserve required client identity |
| Kimi API | `moonshotai` | `moonshotai/kimi-k3` | generic API key | `api.moonshot.ai` | ordinary API terms/privacy approval |

**What survived**

- No target needs a new Autopod runtime.
- All four static-key paths fit one generic Pi API-provider credential flow.
- Autopod manifests should overlay policy/support/network metadata and either reference pinned Pi-native models or define reviewed Pi model configs.

**What changed**

- For Pi-native providers, Autopod should not duplicate Pi's full wire catalog. The manifest pins an allowed/reviewed subset against the shipped Pi version and adds Autopod policy metadata.
- Provider identity must be data (`providerId`/`piProviderId`), while credential mechanism must be a separate kind such as `api-key`; preserving `credentials.provider === account.provider` would perpetuate coupling.
- CLI and desktop provider/model selectors must consume daemon catalog responses rather than compile their own provider arrays.
- Kimi Code OAuth belongs to the pinned-package/bespoke-auth tier; its API-key path does not.

**New unknowns**

- Exact migration naming for legacy `modelProvider` and `ProviderCredentials` fields. This is execution design, not thesis uncertainty, provided compatibility adapters preserve existing profiles.
- Provider terms clarification and sensitive-repository approvals. These remain provider-specific launch gates.

### Round 5 — product preference and Kimi subscription authority

**Pressure applied and why it could change the thesis**

Clarified whether the intended Kimi route is pay-as-you-go Kimi API or Kimi Code membership, and whether ambiguous third-party-client authorization should be accepted experimentally. This changes provider qualification and exit sequencing, though not the generic static-key architecture.

**Evidence**

- The intended product is Kimi Code membership via its manually created API key, not Kimi Open Platform pay-as-you-go API.
- The human selected fail-closed treatment: Kimi Code remains blocked pending explicit Kimi confirmation that Autopod-like unattended use is authorized.

**What survived**

- Kimi Code's static API-key mechanics still fit the generic declarative path through Pi's `kimi-coding` provider.
- Provider authorization is an independent policy gate rather than a transport capability.

**What changed**

- Kimi API is not the preferred first real-provider verification target.
- Kimi Code must not be offered as experimental-with-acknowledgement; it is blocked until provider confirmation.
- Campaign implementation may prove the generic boundary synthetically while integrated Kimi verification waits. Campaign completion still requires approved real-provider evidence.

**New unknowns**

- What written Kimi statement or support response will satisfy the authorization gate.

## Current claim ledger

| Claim | Status | Evidence | Falsifier |
| --- | --- | --- | --- |
| Zen, Go, and Kimi do not need new Autopod runtimes. | supported | All expose APIs; Pi is already a managed provider-neutral runtime. | A required feature only available through a separate provider CLI/session runtime. |
| Current provider onboarding is structurally expensive. | supported | Closed unions and hard-coded inventories span shared, daemon, CLI, desktop, auth, network, and helpers. | A provider can be added today without touching those surfaces. |
| Pi can supply the wire-level provider abstraction. | supported | Built-in providers plus per-model APIs/compat and trusted custom-provider extensions. | Managed Pi cannot load the required provider/auth configuration safely. |
| A provider-wide OpenAI-compatible flag is insufficient. | supported | Zen/Go mix protocols; Kimi has model-specific reasoning/tool/stream requirements. | Conformance tests show one uniform protocol/config works across every supported model. |
| Autopod still needs a curated provider policy/catalog layer. | supported | Pi model discovery does not encode Autopod authority, privacy gates, spend fallback, network policy, or support lifecycle. | Pi exposes stable signed metadata covering all of those concerns. |
| Static API-key providers can become manifest-only additions. | supported for target specimen | All four targets map to pinned Pi providers and one generic API-key injection shape; manifest data supplies support/policy/network metadata. | A conformance spike reveals a target-specific static-key branch or incompatible managed Pi behavior. |
| Compiled manifests should be the ordinary extension unit. | supported | They preserve reviewable deterministic execution while expressing Pi's standard per-model protocol/compatibility metadata. | The specimen cannot represent target providers without executable behavior. |
| Pinned Pi packages should be an escape hatch, not the default. | supported | They maximize fidelity but execute trusted code with pod permissions; static configurations do not need that risk. | Most target providers require custom auth/streaming code rather than Pi-supported APIs. |
| A live remote registry should control pod execution. | rejected for initial design | Council found update speed outweighed by reproducibility, provenance, rollback, and version-matrix risk. | A signed content-addressed approval design proves equivalent to a pinned compiled snapshot. |
| Kimi API is safer for unattended support than Kimi Code membership. | supported as an authorization comparison, but not the selected product | Server-side API positioning versus ambiguous membership tool allowlist. | Kimi explicitly authorizes Autopod-like unattended use of Code membership, or API terms impose equivalent restrictions. |
| Kimi Code membership is the intended Kimi product. | accepted product preference | Human selected subscription rather than pay-as-you-go API. | Human changes the procurement preference. |
| Kimi Code may run experimentally before authorization is resolved. | rejected | Human chose fail-closed treatment. | Explicit Kimi confirmation satisfies the authorization gate. |
| Zen/Go unattended use is authorized. | unresolved/blocking for supported status | Marketing/docs permit coding agents and APIs, but current terms appear contradictory. | Written provider clarification or authoritative terms interpretation resolves the conflict. |

## Convergence assessment

Converged. The thesis is specific and bounded: Pi owns wire/session behavior; Autopod owns credential custody, provider policy, reviewed eligibility, network admission, and catalog-driven UX. The desired gain is observable, the four target products fit the proposed static-key tier, executable extensions are confined to bespoke behavior, and legal/spend/privacy authority is explicit. Strong alternatives were considered: the incumbent is too coupled, a live registry is too mutable, and packages are unnecessarily privileged for static providers.

Remaining unknowns are non-blocking or deliberately deferred: exact compatibility-field migration belongs to execution design, while provider authorization is a per-provider launch gate. Another architecture round is likely to repeat the same trade-off. The next useful work is coordinated maturation of the one weak boundary—manifest-driven provider portability—across shared contracts, daemon auth/config/network/catalog, CLI/desktop dynamic UX, and conformance validation.

## Disposition

`campaign`
