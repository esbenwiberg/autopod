# Checkpoint 111: current dependency audit gate

The clean `02f2513d3a0f1e33e358644594bcae03ebd232dd` full pipeline finished with exit 1. Install, lint, build, typecheck, tests and secret scanning passed; the dependency audit failed. Turbo reused 14 of 15 task results, so their printed historical timestamps are cached proof, not newly executed tests. [Identity](receipts/checkpoint-110-full-validation-identity.json), [full receipt](receipts/checkpoint-110-full-validation.txt).

The current audit identifies `@huggingface/transformers > sharp@0.35.0` as affected by [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), whose patched version is 0.35.4. The existing scoped override is updated to exactly 0.35.4 and its generated lockfile refreshed; no unrelated direct dependency is upgraded. The patched install succeeds and the high-severity audit gate passes with one remaining moderate advisory. This is a required-check repair, not proof that no dependency advisory exists. [Audit](receipts/checkpoint-111-audit.txt), [install](receipts/checkpoint-111-install.txt), [lock update](receipts/checkpoint-111-lock-update.txt).

Full validation follows on a clean commit including this dependency change. Native acceptance continues on loopback fixtures. The whole goal remains incomplete; the acceptance ledger is not promoted by an audit-only pass.
