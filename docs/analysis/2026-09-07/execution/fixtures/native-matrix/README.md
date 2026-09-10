# Native acceptance fixture

This builds the actual desktop entry point under the isolated `com.autopod.acceptance112` app/test identity. It uses a synthetic loopback proxy and fixture child; no production daemon, provider or paid work is involved. Run on an unlocked Mac with Xcode, xcodegen and existing desktop test permissions. Do not run alongside another native acceptance session using this identity.

From the worktree root, prepare a new task-owned directory:

```sh
python3 docs/analysis/2026-09-07/execution/fixtures/native-matrix/prepare.py /private/tmp/autopod-native-next
node /private/tmp/autopod-native-next/native-matrix-proxy.mjs
```

Keep the server running while executing in a separate terminal:

```sh
xcodebuild test -project /private/tmp/autopod-native-next/AutopodAcceptance110.xcodeproj -scheme Acceptance -destination 'platform=macOS' -derivedDataPath /private/tmp/autopod-native-next/DerivedData -resultBundlePath /private/tmp/autopod-native-next/acceptance.xcresult
```

The default twelve cases passed together at checkpoint 115. Unique session URL prefixes isolate retained drafts between cases. The proxy awaits the old child exit before changing fixture mode. Preserve app-window screenshots only; raw Xcode failure bundles may include unrelated system content and must remain private.

`--include-supplemental` includes three pending cases from `SupplementalMatrixTests.swift`: recorded delivery refresh, restart ownership hint and unavailable reviewer binding. They are not acceptance passes: the prior run was interrupted, and the resumed runner failed before test initialization while macOS authentication was active. This option must not be mistaken for a validated extension of the twelve-case matrix.

If activation fails or a system authentication prompt is active, stop UI interaction and wait for the operator to resolve it. Never enter credentials or dismiss security prompts through the harness. Stop only the exact task-owned proxy/app processes after inspecting their identities, and verify their exit and listener removal.

This synthetic UI facility complements backend lifecycle and API regressions. It does not establish deployed source, live provider disposition, worker acknowledgement or actual-image capability. See the current acceptance ledger and checkpoint receipts for those boundaries.


Checkpoint 121 update: supplemental cases have separate direct-CUA proof in checkpoints 117/119, and the remaining worker/waiver/empty-scan/closed-disposition/fleet/provenance/guidance cases have direct proof in checkpoints 120/121. The twelve-case XCTest receipt remains twelve cases; later direct interactions must not be relabelled as XCTest passes. New proxy modes include historical-waiver, empty-scan, closed-merge, populated-provenance and guidance-acknowledged. The acceptance ledger and direct receipts are authoritative for case/source boundaries.
