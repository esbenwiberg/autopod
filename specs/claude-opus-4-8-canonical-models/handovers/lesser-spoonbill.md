# Handover - lesser-spoonbill

## Built

- Updated README and website command/profile examples so public Opus examples
  use `claude-opus-4-8` instead of short aliases.
- Updated escalation copy so `ask_ai` and AI task review are described as using
  `profile.reviewerModel`, with `claude-sonnet-4-6` as the reviewer example.
- Updated the CLI profile creation template to emit `defaultModel:
  claude-opus-4-8` and `reviewerModel: claude-sonnet-4-6`; the nested
  `escalation.askAi.model` value remains only as a canonical legacy wire field.
- Added `scripts/check-canonical-model-copy.sh` to smoke-test the public-copy
  contract.

No intentional deviations from the brief scope.

## Downstream Contracts

- Public examples should not present `opus`, `sonnet`, or `haiku` as accepted
  new input; use canonical IDs such as `claude-opus-4-8`.
- `profile.reviewerModel` is the documented source for `ask_ai` and AI task
  review model selection.
- `escalation.askAi.model` may still appear when explicitly labeled as legacy
  wire compatibility, but it should not be described as the authoritative
  reviewer setting.

## Files To Treat As Owned

- `packages/cli/src/commands/profile.ts`
- `README.md`
- `website/index.html`
- `scripts/check-canonical-model-copy.sh`

Downstream pods should avoid modifying these public-copy examples unless their
brief extends the canonical model documentation contract.

## Landmines

- The copy smoke script intentionally scans only README, website, and the CLI
  template; other internal scripts still contain old aliases for unrelated
  fixtures or dogfood setup and were not changed in this brief.
- The CLI template keeps the hidden/legacy `escalation.askAi.model` payload
  field for compatibility, but it writes a canonical ID and points users to
  `reviewerModel`.
