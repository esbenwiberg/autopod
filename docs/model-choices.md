# Current coding model choices

Updated 2026-11-18 using official documentation verified by the parent task.
The supplied checkout was `f64e1835ad9a0e6fe90f916b87419fe028f20b54`;
it already contains Opus 5.5 and Sonnet 5.5 profile defaults, newer than the
earlier inspected `91f0e11e322d001c3390070fe036371a205f4183` baseline.

Claude choices are Opus 5.5, Sonnet 5.5, Fable 5.2 and Haiku 5.5. Workers
remain Opus-first and reviewers Sonnet-first. Codex choices are Auto,
GPT-6.2 Sol (not 5.2), GPT-6.2 Astra, GPT-6.1 Terra and GPT-6 Luna.
Mythos 5.2 is verification-gated and is excluded from default coding choices.

Sources: [OpenAI models](https://developers.openai.com/api/docs/models),
[Codex models](https://developers.openai.com/codex/models/), and
[Claude model overview](https://platform.claude.com/docs/en/about-claude/models/overview).
Availability depends on the account, provider authorization and installed client.
Picker presence does not establish that an existing worker image can run a model;
no live CLI compatibility test or image rebuild is included in this cleanup.

New standard USD rates per million input / cached input / output tokens:

| Model | Input | Cached | Output |
| --- | ---: | ---: | ---: |
| [GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) | 8 | 0.40 | 40 |
| [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) | 2 | 0.10 | 10 |
| [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) | 1 | 0.05 | 5 |
| [Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview) | 8 | 0.20 | 40 |
| [Haiku 5.5](https://platform.claude.com/docs/en/models/haiku-5-5/overview), from | 0.10 | 0.01 | 0.50 |

Haiku 5.5 base rates apply to prompts up to and including 100,000 tokens.
Above 100k, input / cached input / output rates are $0.50 / $0.05 / $2.50.
The shared flat-rate schema and aggregate token counts cannot apply per-request
tiers; Haiku calculations are base estimates and can understate actual bills.
Desktop pricing explicitly shows the threshold. Reported provider costs remain
preferred where available. Historical prices and short alias mappings are unchanged.

Known saved models outside the curated lists remain selectable with a Legacy
label; arbitrary compatible custom IDs are retained without that label. Profile,
reviewer and failover pickers and Podsitter use the central options. The composable
launch AI/failover editor accepts an explicit model string and starts empty;
it has no stale model fallback to replace. New profile
constructors, response defaults and mapper missing-value fallbacks retain
Opus 5.5 / Sonnet 5.5. Existing profiles, pods and frozen launches are not migrated.
Pi's stale offline examples are removed: Auto remains the fallback and explicit
choices continue to come from the existing authorized active provider catalog.
No provider manifest, authentication or authorization rules are expanded.

The portable source-contract script checks curated lists and wiring only;
Swift behavioral tests and `scripts/test-desktop.sh` require Mac/CI execution.
