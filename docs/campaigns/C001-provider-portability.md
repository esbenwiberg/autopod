# C001: Provider portability boundary

## Status

`not yet verified`

## Origin

- Deliberation: [`D002-provider-portability`](../deliberations/D002-provider-portability.md)
- Accepted direction: Pi owns provider wire/session behavior; Autopod owns credential custody, reviewed eligibility, policy, network admission, and catalog-driven UX.
- Decisive evidence:
  - the pinned Pi runtime already supports OpenCode Zen, OpenCode Go, Kimi Code, and Moonshot/Kimi API providers;
  - all four static-key paths fit one Pi auth shape;
  - Autopod's closed provider unions, environment switch, runtime coupling, network defaults, and client arrays—not provider transport—are the current onboarding bottleneck;
  - compiled manifests preserve deterministic review, while pinned Pi provider packages cover genuinely bespoke behavior.

## Mission

Mature Autopod's static API-provider boundary from provider-specific code paths into one reviewed manifest-to-Pi path without weakening credential isolation, managed-worker trust, network restrictions, or existing provider behavior.

## Earned gain

A conforming static-key model provider can be made safely selectable and runnable in Autopod by adding reviewed provider/model manifest data and conformance fixtures, **without adding a runtime type, a provider branch in daemon execution code, or provider entries to CLI/desktop source lists**.

## Weak boundary

```text
reviewed provider manifest + encrypted provider account + provider-qualified model
  -> resolve eligibility and account ownership
  -> generate pinned Pi provider/model/auth configuration
  -> admit declared network hosts
  -> run through managed Pi and normalize evidence
  -> selectable provider-backed pod with attributable usage and policy state
```

Current weakness: provider identity, credential mechanism, runtime selection, API surface, model metadata, UI inventory, and network policy are conflated across closed unions and repeated switches.

## Authority fence

### Campaign-level authority

The campaign may:

- introduce a versioned compiled provider-manifest contract;
- separate provider identity from credential mechanism;
- add generic static API-key credential storage and Pi provisioning;
- expose daemon catalog/account metadata consumed by CLI and desktop;
- derive restricted-network hosts from reviewed manifests;
- add compatibility adapters that preserve existing profiles and provider accounts;
- qualify providers/models as experimental, supported, deprecated, blocked, or authorization-pending;
- add deterministic conformance fixtures and an approved real-provider verification path.

### Worker-local authority

Workers may choose reversible module names, internal helper boundaries, test-fixture organization, serialization helpers, and UI presentation details that preserve this contract and repository conventions.

### Human gates

Explicit human approval is required before:

- Shape dispatches implementation;
- a provider with ambiguous terms is marked supported for unattended pods;
- a real credential is used in integrated verification;
- a migration removes or irreversibly rewrites legacy provider/profile data;
- a live remote registry gains execution authority;
- validation is waived;
- scope expands to automatic provider failover, spend routing, or migration of existing vendor runtimes.

### Escalation conditions

Pause affected work and return to deliberation or human review if:

- a target static-key provider requires a new Autopod runtime or unpinned executable code;
- Pi cannot consume secrets without exposing raw keys in process/container metadata;
- provider/model identity cannot be made data-driven without breaking existing profile inheritance or account ownership;
- dynamic client catalogs cannot preserve offline/profile-edit behavior;
- conformance evidence reveals model-specific behavior that the pinned Pi provider cannot represent;
- provider terms, privacy, or spend behavior contradict an intended support status.

## Invariants

- Runtime remains the coding-agent implementation; provider remains backend/billing/auth identity.
- Static API providers run through the existing managed Pi runtime.
- Raw provider keys remain encrypted at rest and absent from public API responses, logs, command arguments, generated ordinary config, and inspectable process environment.
- Managed pods do not load executable repository-local provider resources.
- A pod runs against provider/model metadata compatible with its pinned Pi version.
- Protocol and compatibility are model-level facts; no provider-wide “OpenAI-compatible” shortcut may erase them.
- Restricted network policy admits only reviewed hosts required by the selected provider plus existing explicit policy.
- Provider terms/privacy/spend status is visible and can block launch.
- Subscription exhaustion must not silently become metered spend.
- Existing Claude, Codex, Copilot, MAX, Foundry, OpenRouter, and Pi OAuth behavior remains compatible unless separately authorized.
- Daemon-side LLM helpers may remain best-effort/provider-limited initially; they must report honest fallback rather than silently use another account.
- A live remotely mutable catalog is not authoritative for execution in this campaign.

## Pressure cases

### Accepted

- A new provider uses a static API key and a Pi-supported protocol. Its manifest declares a stable ID, Pi provider mapping or model configs, approved models, required hosts, support state, and policy metadata.
- OpenCode Zen or Go uses Pi's pinned native provider catalog while Autopod overlays reviewed model eligibility and provider policy.
- Kimi Code membership is the intended Kimi product and uses a manually created API key through the generic static-key path only after explicit Kimi authorization for Autopod-like unattended use.
- Kimi API remains technically compatible through the pinned `moonshotai` Pi provider, but it is not the selected procurement or verification path.

### Ambiguous

- A provider offers both static API key and OAuth. Static-key support may ship declaratively; OAuth remains unavailable until a pinned trusted adapter is separately qualified.
- Pi updates a built-in provider catalog. New models remain unavailable until the Autopod manifest reviews them; removed/incompatible models surface a deterministic preflight error.
- A provider changes price, retention, quota fallback, or model routing. Support state may be downgraded independently of transport compatibility.
- A profile inherits provider/model/account fields from different ancestors. Effective resolution must prove one coherent provider-account/model tuple.

### Rejected

- Arbitrary user-supplied provider base URLs without SSRF/network/trust controls.
- Repository-provided Pi provider extensions in managed pods.
- Auto-enabling every model returned by a provider `/models` endpoint.
- Adding `zen`, `go`, or `kimi` to `RuntimeType`.
- Hard-coding the new provider into Swift or CLI arrays.
- Storing the API key directly in `models.json`, ordinary Pi auth JSON, process environment, pod events, or logs.
- Marking ambiguous unattended use as supported based only on technical compatibility.

### Failure behavior

- Unknown, blocked, deprecated-without-waiver, or authorization-pending provider/model: fail before provisioning with a stable reason.
- Missing/mismatched provider account: fail before provisioning without exposing credential metadata.
- Manifest/Pi-version incompatibility: fail closed with the expected and actual catalog/version evidence.
- Provider quota/rate/auth failure: preserve normalized provider error evidence; do not silently change provider or spend source.
- Required network host absent from resolved restricted policy: fail preflight rather than weakening the policy.

## Ordered delivery slices

### 1. Establish the versioned provider catalog and compatibility seam

Outcome:

- one compiled manifest contract represents provider identity, Pi mapping, authentication kinds, reviewed models, support lifecycle, required hosts, and policy/spend/privacy metadata;
- legacy model-provider values resolve through an explicit compatibility adapter;
- daemon API returns catalog data suitable for clients without exposing secrets;
- manifest/schema validation rejects duplicate IDs, unsafe hosts, incompatible model references, and unsupported auth declarations.

Dependency: none.

### 2. Prove generic static-key custody and managed Pi provisioning

Outcome:

- provider accounts can bind a data-driven provider ID to an `api-key` credential kind;
- encrypted storage, redaction, ownership matching, and inheritance work without provider-specific credential unions;
- selected credentials produce Pi auth/config that refers to a restricted secret file rather than embedding the key;
- post-exec persistence does not overwrite static keys with generated placeholders;
- legacy rotating/OAuth credentials retain their specialized persistence paths.

Dependency: slice 1 provider identity/auth declarations.

### 3. Resolve provider-qualified models, support gates, and network admission

Outcome:

- pod preflight resolves one coherent runtime/provider/account/model selection;
- Pi is selected for manifest API providers without adding runtime types;
- support/authorization/deprecation state can block or warn deterministically;
- restricted network defaults derive from the selected manifest;
- normalized events and usage remain attributed to provider-qualified models.

Dependency: slices 1–2.

### 4. Replace compiled client inventories with daemon-driven provider/model UX

Outcome:

- CLI and desktop create/filter/authenticate generic API-key provider accounts from daemon catalog metadata;
- profile editing selects compatible provider-qualified Pi models from daemon data;
- provider labels, icons/fallbacks, support status, privacy/spend caveats, and auth instructions are data-driven;
- adding a conforming manifest does not require CLI or Swift provider-list changes.

Dependency: slices 1–3 catalog and resolution APIs.

### 5. Qualify initial providers and verify changed reality

Outcome:

- Kimi Code membership is the preferred Kimi verification target, but remains blocked—not experimental—until Kimi explicitly authorizes Autopod-like unattended use;
- Zen and Go remain authorization-pending until their provider-specific gates are resolved;
- Kimi API may be represented as technically compatible but is not the selected procurement path;
- a synthetic compatible provider fixture proves the generic path while authorization is pending, and at least one subsequently approved real provider must exercise that same path before campaign completion;
- existing provider/runtime regression suites remain green.

Dependency: integrated slices 1–4.

## Exit evidence

The campaign earns its gain only when all of the following exist:

1. **Manifest-only change proof:** a test-only conforming provider is added by manifest/fixture data with no diff to runtime types, daemon provider execution switches, or CLI/desktop provider arrays; catalog, account creation, profile selection, preflight, network resolution, and managed Pi configuration tests pass.
2. **Secret-boundary proof:** deterministic tests show the raw API key exists only in encrypted persistence and the restricted in-container secret file—not public responses, logs, command arguments, environment, or generated ordinary config.
3. **Protocol/model proof:** mixed-protocol and Kimi-specific fixture models resolve to the pinned Pi provider metadata expected by the manifest; mismatches fail closed.
4. **Integrated real-provider proof:** after provider authorization and explicit human credential approval, one bounded non-sensitive repository task completes through an approved target provider—preferably Kimi Code membership—using the generic path and produces attributable normalized runtime/validation evidence. Synthetic proof alone leaves status `not yet verified`, not `complete`.
5. **Client proof:** CLI and desktop discover the new provider/model from daemon responses without source changes naming that provider.
6. **Regression proof:** shared, daemon, CLI, and desktop suites covering legacy provider accounts, profile inheritance, runtime resolution, secret redaction, network restrictions, and managed Pi remain green.
7. **Policy proof:** authorization-pending, blocked, deprecated, and metered-fallback cases produce the specified preflight/warning behavior.

Falsification evidence includes any required provider-specific runtime/client branch, secret exposure, silent model/protocol fallback, unreviewed remote catalog affecting execution, or inability to complete the real-provider task through the generic boundary.

## Non-goals

- Automatic provider failover or quota-continuation policy (tracked separately in `D001-provider-limit-continuity`).
- A marketplace or public third-party provider plugin ecosystem.
- Live remote registry authority or automatic catalog activation.
- Replacing Pi's wire adapters with Autopod-owned OpenAI/Anthropic SDK abstractions.
- Rewriting existing vendor runtime implementations.
- Supporting every model advertised by Zen, Go, Kimi, Moonshot, or arbitrary aggregators.
- Kimi Code OAuth in the declarative static-key slice; the selected subscription path is its manually created API key.
- Unified daemon-side LLM helper support for every provider.
- Automatic price arbitrage, subscription selection, or metered fallback.
- Provider procurement, legal interpretation, or sensitive-data approval.

## Results

Implementation series `provider-portability` ran five ordered pods, but remains blocked and incomplete pending required validation and independently authorized real-provider evidence:

1. `colorful` — provider catalog contract and API;
2. `blushing` — generic API-key custody and Pi provisioning;
3. `brainy-g` — provider/model/policy/network resolution;
4. `late-rhi` — daemon-driven CLI and desktop UX;
5. `nasty-bobcat` — manifest-only conformance and initial provider posture.

Synthetic integrated proof ran through catalog discovery, encrypted generic account creation and redacted API responses, profile/account linking, provider-qualified model preflight, and the production `processPod()` path with mocked runtime, container, and network dependencies. Observed calls prove manifest-derived restricted-network admission, restricted secret-file writes, managed Pi auth generation, provider/model binding, and secret-free runtime spawn inputs. Static architecture checks prove the synthetic provider remains test/manifest data: `RuntimeType` is unchanged, daemon production sources do not name it, and CLI/desktop production sources contain no provider inventory entry for it. Focused CLI and desktop fixtures consume the same provider shape dynamically.

The sentinel secret-boundary proof ran and requires the raw key to appear only after decryption and in `/run/autopod/model-provider-key`; public account/profile responses, generated ordinary files, environment, arguments, captured logs, and persistence flags remain free of the sentinel.

Initial policy proof ran without real credentials. OpenCode Zen and OpenCode Go remain `authorization-pending`, Kimi Code remains `blocked`, and Kimi API remains `authorization-pending`; preflight rejects all four before managed Pi provisioning. No account, provider, model, or spend-source fallback is enabled.

Integrated real-provider evidence was **not run** because Kimi authorization and separate credential approval have not been granted. The campaign therefore remains `not yet verified`.

Validation evidence for `nasty-bobcat`:

- **Ran and passed:** all three required fact commands; the complete synthetic integration file (4 tests); focused CLI provider-catalog discovery (5 tests); focused daemon provider-account regression plus portability integration (14 tests); repository install, lint, build, typecheck, and secret scan; and 3,470 of 3,472 daemon tests. The CLI, shared, Pi worker, escalation MCP, validator, mobile-web, and placeholder e2e suites passed.
- **Ran and failed for sandbox/repository-state reasons:** the full test step had 2 failures in `credentials-cipher.test.ts` because this mounted filesystem does not preserve requested `0644`/`0640` modes, so the permission-enforcement assertions observe `0600`; the dependency audit reported 25 existing advisories (2 low, 12 moderate, 11 high). Neither failure is in the provider-portability diff.
- **Did not run:** desktop Swift `ProviderCatalogTests` because the sandbox has no `swift` executable; integrated real-provider execution because provider authorization and credential approval are absent.
- **Waived:** none. No waiver was requested or granted.

## Reflection

To be completed from integrated evidence. The campaign must record separately:

- what survived from the manifest-first thesis;
- where Pi-provider behavior or client migration contradicted it;
- whether the earned gain was proved, narrowed, or falsified;
- evidence that may justify future deliberation without automatically authorizing adjacent work.
