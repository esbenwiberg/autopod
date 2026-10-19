# Azure AI Foundry provider accounts

Run pods against Claude (via Claude Code) or OpenAI models (via Codex) deployed
in an Azure AI Foundry resource, authenticated with the resource's API key.

## Setup

1. In the Foundry portal, deploy the model(s) you want and note each
   **deployment name**. Copy the endpoint and Key 1 from the resource's
   **Keys and Endpoint** page.
2. Create the account:
   - **Desktop**: Settings → Provider Accounts → New → provider *Azure AI
     Foundry*. Fill in endpoint, API key and surface. Use the ⟳ button on the
     row to replace the endpoint/key later.
   - **CLI**:
     ```bash
     ap provider-account create "Foundry Claude" --provider foundry
     AUTOPOD_PROVIDER_API_KEY=... ap provider-account auth-foundry <id> \
       --endpoint https://<resource>.services.ai.azure.com/anthropic
     ```
     Omit the env var to be prompted. The key is never accepted as a flag, so
     it stays out of shell history and `ps`.
3. Link the account to a profile and set the profile's model to the
   **deployment name**.

## Gotchas

- **Model = deployment name.** Foundry routes by deployment, not by
  Anthropic model ID. If you named your deployment `claude-opus-4-1`, that is
  the model string; a deployment named `prod-opus` must be referenced as
  `prod-opus`.
- **Endpoint forms.** The resource root, the `/anthropic` base, and a pasted
  portal Target URI ending in `/v1/messages` are all normalised to
  `https://<resource>.services.ai.azure.com/anthropic`. Other paths are kept
  verbatim for custom Anthropic-compatible gateways. Endpoints must be https.
- **Restricted networks.** Canonical Azure hosts (`*.services.ai.azure.com`,
  `*.openai.azure.com`, `*.cognitiveservices.azure.com`, default port) are
  added to a restricted pod's egress allowlist automatically. A custom gateway
  host must be added to the profile's network policy by hand.
- **Surfaces.** `anthropic` runs Claude Code with the `ANTHROPIC_FOUNDRY_*`
  variables. `openai` runs Codex through an `azure-foundry` model provider that
  the runtime writes into `~/.codex/config.toml`, pointing at
  `https://<resource>.services.ai.azure.com/openai/v1` (Responses API, HTTP
  transport). Codex ignores `OPENAI_BASE_URL` on its own; without that provider
  entry it would call api.openai.com. The resource root, `/openai`,
  `/openai/v1`, and URLs ending in `/responses` or `/chat/completions` all
  normalise to that `/openai/v1` base.
- **Images.** Claude Code reads `ANTHROPIC_FOUNDRY_*` variables; pods built
  from stale base images with an old Claude Code may ignore them. Rebuild
  images if Foundry pods hit `api.anthropic.com`.

## Keyless (Entra ID) auth

Provider accounts require an API key today. Keyless auth works only through a
legacy profile's inline Foundry credentials: the daemon mints an Entra token
via `DefaultAzureCredential` at spawn/resume, so a single agent turn longer
than the token lifetime (~60–90 min) will hit 401s. Importing such a profile
into a provider account is refused rather than producing an account that
cannot launch.
