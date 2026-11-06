# Repair-continuation wire fixtures

`repair-continuation-v1.json` is the small client fixture. Its available inspection
has `sourceHead: null`, matching production; its opaque retained operation/custody
ID is deliberately different from the external request replay key.

`repair-continuation-backend.json` is an unmodified capture from the real manager
lifecycle and `operation()`/`inspect()`/`preview()` producers in
`packages/daemon/src/pods/repair-continuation.test.ts` (test “feeds actual
inspection…”). It contains claimed, qualified-before-coding, failed qualification,
and sealed/validated projections. The fixture uses real SQLite/Git and mocked
container/probe/runtime/validation infrastructure. It is **not live qualification
proof**. Evidence IDs are retained verbatim, not rewritten to request keys.

For a fresh producer-to-native regression, set `REPAIR_CLIENT_PRODUCER_FIXTURE` to
an absolute temporary JSON path for both commands, run from repository root:

```sh
SKIP_DB_TESTS=0 REPAIR_CLIENT_PRODUCER_FIXTURE=/tmp/repair-client-wire.json \
  npx pnpm --filter @autopod/daemon exec vitest run \
  src/pods/repair-continuation.test.ts --maxWorkers=1
REPAIR_CLIENT_PRODUCER_FIXTURE=/tmp/repair-client-wire.json \
  swift test --package-path packages/desktop --no-parallel \
  --filter 'AutopodClientTests.RepairContinuationTransportTests'
REPAIR_CLIENT_PRODUCER_FIXTURE=/tmp/repair-client-wire.json \
  swift test --package-path packages/desktop --skip-build --no-parallel \
  --filter 'AutopodUITests.RepairContinuation'
```

The backend test always runs the actual CLI correlation validators against fresh
producer results. Capture is opt-in and never rewrites committed fixtures during
normal tests. Native tests use the fresh capture when the environment variable is
set, otherwise the committed backend capture. CLI tests also consume the capture.
Keep client/native processes separate; these tests never call a live daemon.
