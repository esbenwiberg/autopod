# Desktop test process isolation

Run the desktop regression checks from the repository root:

```sh
./scripts/test-desktop.sh
```

The runner builds and lists the complete Swift test inventory, discovers its
module names and executes every discovered test target in a fresh process with
`--no-parallel`. An empty/unrecognized inventory or any failing target fails the
command. It does not maintain an allowlist of targets or exclude individual
tests. XCTest and Swift Testing both run. The existing read-only live-daemon
acceptance suite remains opt-in, as before.

## Why isolate targets

On this Mac (macOS 26.7.1 / Xcode 26.6 / Swift 6.3.3), running all targets in one
Swift Testing process reproducibly reaches five assertions in the two bundled
Village WebKit tests. At the investigated baseline `7151cc66`, that command
completed 552 Swift Testing tests with those five issues in 66.773 seconds.

Temporary delegate tracing established:

1. The renderer's bundled document navigation is allowed on the main thread.
2. The native policy completion is called, but WebKit never reports provisional
   navigation, response, commit or finish. Loading remains true at progress 0.1.
3. System logs reach `SOAuthorizationCoordinator::tryAuthorize` and do not report
   an SSO decision before the unchanged ten-second renderer timeout.
4. In the passing isolated run, the SSO check immediately says the URL is not
   registered for AppSSO handling; provisional navigation, commit, finish and
   the renderer handshake then complete.

This identifies the observed stalled boundary. It does not establish why a
particular ordering of the earlier HTTP/AppKit fixtures leaves the OS check in
that state. A background URLSession initialization and one mocked HTTP request
alone did not reproduce it. Do not claim the renderer's JavaScript or its asset
loading failed: neither began in the failing run.

WebKit's upstream [AppSSO navigation fix](https://github.com/WebKit/WebKit/commit/111ec8a8a585f7d2764b373a0ef28fa8772cc5a9)
documents a related indefinite authorization-check wait for locally served
content when AuthKit cannot obtain its data. It also explains why registering a
local URL scheme is not sufficient on affected framework versions. This is
supporting context, not proof that this exact system has the same trigger.

## Preserved coverage

Before changing the runner, all three original targets passed separately:

| Target | Swift Testing | XCTest |
| --- | ---: | ---: |
| AutopodClientTests | 355 | 0 |
| AutopodDesktopTests | 11 | 7 |
| AutopodUITests | 186 | 6 |
| Total reported | 552 | 13 |

The full inventory contains 565 test declarations. The runner discovers this
inventory each time, so a new test target is picked up automatically. The real
WebKit tests still load the bundled HTML, CSP, scripts and images and assert
snapshot replacement, canvas hit testing, native/managed selection, stale IDs,
hostile titles, animation and disposal. No assertions, timeout or production
renderer code change for this isolation fix.

The original monolithic command remains a useful diagnostic reproducer:

```sh
swift test --package-path packages/desktop --no-parallel
```

It still has the local OS-framework interaction; a passing isolated runner is
not evidence that this command was fixed. The earlier Xcode 16.4 / Swift 6.1.2
CI run passed the monolithic suite. CI now uses the same target-isolated runner
as local validation.

## Rejected experiments

Temporary diagnostic probes were removed. Creating 89 plain native windows did
not reproduce the failure. Replacing the async policy delegate with an immediate
completion still failed. Pumping the native run loop did not fix it. A confined
`WKURLSchemeHandler` loaded correctly alone but still entered AppSSO and failed
in the full process; it was reverted. An in-memory HTML-load probe also failed
and was reverted. No private WebKit authentication switches, network-policy
changes, increased timeouts or test retries are used.

## Acceptance boundary

These are offline test fixtures. Process isolation does not establish connected
Preview navigation or real daemon/provider execution. The live walkthrough is
still deferred while the user's Mac is locked; keep the redesign PR draft.

## Validation of the runner

The inventory-driven command passed locally with 355 + 11 + 186 Swift Testing
tests and 7 + 6 XCTest tests. A separate direct per-target run also passed.
A controlled fake-Swift check verified automatic discovery of multiple targets,
rejection of empty and malformed inventories, propagation of discovery errors,
and propagation of target test failures. `bash -n scripts/test-desktop.sh` passed.
The Village host/update contract tests (15) and `npx pnpm village:check` passed.
