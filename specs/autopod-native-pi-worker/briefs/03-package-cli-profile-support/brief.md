---
title: "Package Pi and expose CLI profile support"
touches:
  - packages/daemon/src/images/dockerfile-generator.ts
  - packages/daemon/src/images/dockerfile-generator.test.ts
  - packages/daemon/src/pods/runtime-resolver.ts
  - packages/daemon/src/pods/runtime-resolver.test.ts
  - packages/daemon/src/profiles/profile-validator.ts
  - packages/daemon/src/profiles/profile-validator.test.ts
  - packages/cli/src/commands/profile.ts
  - packages/cli/src/commands/profile.test.ts
does_not_touch:
  - packages/desktop/
  - packages/daemon/src/containers/
  - packages/daemon/src/actions/
require_sidecars: []
---

## Task

Make the Pi runtime usable from TypeScript product surfaces. Install pinned Pi and the trusted worker package in generated images while retaining all existing agent CLIs. Accept and validate Pi in profiles and pod runtime resolution without changing legacy defaults. Add CLI selection and isolated, per-provider Pi subscription authentication for profiles and provider accounts.

## Research summary

Sandbox pods require ACR warm images, so Pi cannot be runtime-installed. Existing image generation installs every supported CLI and tests their presence. CLI and desktop auth precedents isolate vendor homes, run interactive login, capture credentials, and patch encrypted owners. The Pi auth contract from Brief 02 stores one selected provider entry. Read `research.md`, `plan.md`, and upstream handoffs before coding.

## Plan

Pin Pi in image generation and bake the built worker package into the managed image. Extend runtime validation/resolution additively. Add CLI commands that run `/login` with an isolated `PI_CODING_AGENT_DIR`, validate that exactly the requested provider entry exists, patch only that entry, and clean temporary material. Support profile and shared provider-account ownership.

## Checkpoints

1. Add pinned image installation with retained legacy CLIs.
2. Enable Pi in profile validation and runtime resolution while preserving defaults.
3. Add isolated profile and provider-account Pi login commands.
4. Cover cancellation, wrong provider, malformed file, missing executable, and successful capture.

## Touches

- `packages/daemon/src/images/dockerfile-generator.ts`
- `packages/daemon/src/images/dockerfile-generator.test.ts`
- `packages/daemon/src/pods/runtime-resolver.ts`
- `packages/daemon/src/pods/runtime-resolver.test.ts`
- `packages/daemon/src/profiles/profile-validator.ts`
- `packages/daemon/src/profiles/profile-validator.test.ts`
- `packages/cli/src/commands/profile.ts`
- `packages/cli/src/commands/profile.test.ts`

## Does not touch

- `packages/desktop/`
- `packages/daemon/src/containers/`
- `packages/daemon/src/actions/`

## Constraints

Follow ADR-033 and the provider-entry contract in `design.md`. Do not use `latest` for Pi. Do not remove or conditionally omit existing CLIs. Temporary auth directories must be restrictive and always removed. Never print credential JSON. Existing profiles must retain their runtime and model defaults.

## Test expectations

Update image tests to assert a pinned Pi package and trusted worker package coexist with Claude, Codex, and Copilot. Update resolver/validator tests to distinguish Pi selection from unchanged defaults and provider compatibility. Add CLI tests with isolated fake auth files proving only the requested provider is patched and failure paths leave credentials unchanged.

## Risks / pitfalls

The workspace worker package must be available in generated image build context. Pi's provider IDs do not equal every Autopod `ModelProvider` value. Interactive login success must be based on a valid selected entry, not merely process exit or file existence.

## Wrap-up

Before finishing:
1. Run the profile finish prompt if one is configured.
2. Re-run build and tests; both must still pass.
3. Commit and push.
