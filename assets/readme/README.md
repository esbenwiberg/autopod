# README media

The desktop screenshots and tour show **real SwiftUI/AppKit components with
offline fixture data**. `features.png`, `security.png`, and `acp.png` are editorial
product, security, and action-flow diagrams, not screenshots. None of these images is a live task execution, benchmark,
passing validation claim, or proof that a PR was delivered. The redesigned desktop interface is enabled in
the preview; it can also be selected in the app's Appearance settings.

## Provenance

- Application source: `b66e6d0219fd9467b67e4bef038425bce541135c`.
- Initial compositor: Python 3 with Pillow 11.3.0.
- Fixture: `packages/desktop/Sources/AutopodDesktop/Views/DesktopDesignPreview.swift`.
- Host: [capture-native.swift](capture-native.swift), using `NSHostingView` and
  `cacheDisplay`, the same native-rendering technique used by the desktop tests.
- Views: Overview, Work, Readiness, and Diff for `retry-demo`.
- No daemon/provider connection, production app installation, external screen
  capture, private task data, or successful approval is involved.
- The capture clicks the real in-process accessibility tab controls. It does not
  replace statuses, warnings, code, counts, or costs in the screenshots.

`desktop.png` adds a frame around the fleet capture. `readiness.png` is a
captioned close-up of the actual detail panel. `tour.gif` is a looping,
captioned **still-frame UI tour**, not a time-lapse of task execution. It uses
four views with short crossfades; the captions and framing are editorial.
The original fixture's warnings and missing evidence remain visible.

## Feature overview

`features.png` uses the same dark gradient, lavender accents, Arial typography,
and rounded panels as the screenshot frames and tour. Its six feature cards
explain benefits rather than inventing performance or security guarantees;
the five-step flow includes the retry loop and configuration/policy caveats.
The README uses descriptive alt text and links to the detailed guides rather
than repeating the visible feature cards and steps in a second list.

The claims are grounded in the linked [validation](../../docs/reference/validation.md),
[profile](../../docs/reference/profiles.md), [workflow](../../docs/reference/cli.md),
and [mobile](../../docs/mobile.md) guides. In particular, the phone can approve or
reject work; the graphic does not imply it has the desktop's Readiness UI.

Regenerate this graphic independently of native captures:

```bash
python3 assets/readme/features.py
```

Requires Python 3, Pillow, and the macOS Arial fonts, but no Xcode build, raw
captures, screen permissions, daemon, or provider. Open the result at full size
and around 850 pixels wide (typical README content width); inspect card copy,
alignment, contrast, arrows, and footer text before publishing.

## Security overview

`security.png` matches the same visual system. It distinguishes enabled worker
egress policy, daemon action permissions, and configured action-response filters, then
shows stored-credential protection, pod identity, and audit/readiness evidence.
The checkout/account band explicitly keeps local Git usable without implying
inheritance of the daemon's source-service identity. The action card names
GitHub context, log queries, preconfigured PIM activation, and HTTP integrations;
these are policy-gated requests, not arbitrary account access.
It is not a live enforcement test, certification, or promise of complete
prompt-injection prevention. The source-checked [security guide](../../docs/security-overview.md)
records exceptions, limitations, implementation links, and the inspected revision.
The README links there without mirroring the graphic as another bullet list,
and explicitly notes that the default remote-MCP proxy does not wire its optional
response filters. Don't silently widen the action-filter claim to all MCP traffic.

Regenerate independently of all screenshots:

```bash
python3 assets/readme/security.py
```

This needs the same Python/Pillow/fonts as the feature graphic. Inspect both
full-size and around 850 pixels wide. Keep the egress exceptions, configuration
scope, and non-immunity footer readable; never replace them with absolute
“no credentials leave” or “zero outbound” claims.

## Dedicated Action Control Plane diagram

`acp.png` gives ACP its own visual: pod request → policy gate → daemon handler →
configured response controls → result. A separate denial/approval branch stops
before handler execution; the audit band explicitly avoids promising a record
for every pre-dispatch denial. Example integrations are GitHub, Azure DevOps,
Azure/application logs, preconfigured PIM, and configured HTTP operations.

The diagram follows the source-checked [action boundary guide](../../docs/security-overview.md#brokered-tools-not-ambient-authority).
Approvals and response filters are conditional on configuration. PIM choices,
scopes, durations, eligibility and tenant policy remain constraints; no arbitrary
elevation or live activation is implied. This is the action engine's response
path, not the remote-MCP proxy's unwired optional filters.

```bash
python3 assets/readme/acp.py
```

The same Python/Pillow/macOS fonts are required. Inspect the full image and an
850px-wide version, including arrow directions, denial branch and footer.
Keep its content in the image with descriptive alt text and a guide link, not a
second visible copy in the README.

## Regenerate native media

Requires macOS 15+, Xcode with local signing available, Git, Python 3, and Pillow.
The compositor uses the macOS Arial fonts. Install Pillow in your own Python
virtual environment if it is not already available; it is not a project runtime
dependency.

From the repository root:

```bash
bash scripts/capture-readme.sh /absolute/path/to/raw-captures
python3 assets/readme/compose.py /absolute/path/to/raw-captures
```

The capture script archives the **committed `HEAD` desktop source** into a
throwaway directory, swaps only that copy's entry point for the offline host,
builds it with a separate bundle identity, renders PNGs, and removes the
throwaway build. It never edits application source in the checkout or installs
over `/Applications/Autopod.app`. The output includes `source-revision.txt` and
`capture-host.sha256`: the committed application revision and the SHA-256 of the
exact renderer overlay copied into the build (which may be uncommitted).
Update the application provenance above to that revision and retain the matching
renderer with new captures. Raw captures are local intermediates, not additional
repository assets.

The compositor checks the original capture dimensions before applying its crop.
If a macOS or layout change alters them, inspect the raw images and update the
crop deliberately; don't blindly resize a broken layout. Sample timestamps and
durations are time-relative and need not be byte-identical on regeneration.

## Checks before publishing

- Open all five PNGs and inspect every GIF chapter, not just its first frame.
- Check that labels are readable, no private information is shown, and the
  sample-data disclosure remains visible.
- Keep total published media below 3 MiB. PNGs are 1624×1044 (desktop),
  1280×800 (readiness), 1624×1256 (features), 1624×1162 (security),
  and 1624×1104 (ACP); the GIF is 1280×800, 20 frames,
  and approximately 14.6 seconds per loop.
- Keep a static alternative in the README and meaningful image alt text.
- Run `bash -n scripts/capture-readme.sh` and `git diff --check`.
