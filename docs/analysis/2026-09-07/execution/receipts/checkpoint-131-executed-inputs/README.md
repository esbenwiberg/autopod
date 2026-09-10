# Immutable executed canary inputs

These `.txt` files contain the exact pre-format runner, local-test, contract and metadata bytes. The manifest maps each former fixture path to its archive member and SHA-256. Use these archive members when verifying historical CP126–131 runner/contract hashes; maintained fixture copies were subsequently formatted/linted for the repository pipeline. No receipt status or executed bytes were rewritten.

The consumed runners deliberately retain their original hash guards and single-use journals; they are not newly authorized reusable launchers. A future canary requires a fresh pinned packet under the continuing user authorization.

For CP131 local harness checks, use `node docs/analysis/2026-09-07/execution/fixtures/replay-canary-local-checks.mjs test-canary-resource-131-new-attempt.mjs run-canary-resource-131-new-attempt.mjs` (or the corresponding Codex / NuGet filenames). The wrapper supplies immutable input bytes to the historical text-replacement harness; it does not modify on-disk contracts and its local network responses remain mocked.
