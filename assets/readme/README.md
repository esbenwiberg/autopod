# README media

The desktop screenshots and tour show **real SwiftUI/AppKit components with
offline fixture data**. `features.png` is a separate editorial product overview,
not a screenshot. None of these images is a live task execution, benchmark,
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
The README also describes these features and steps in ordinary Markdown.

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

- Open all three PNGs and inspect every GIF chapter, not just its first frame.
- Check that labels are readable, no private information is shown, and the
  sample-data disclosure remains visible.
- Keep total published media below 3 MiB. PNGs are 1624×1044 (desktop),
  1280×800 (readiness), and 1624×1256 (features); the GIF is 1280×800, 20 frames,
  and approximately 14.6 seconds per loop.
- Keep a static alternative in the README and meaningful image alt text.
- Run `bash -n scripts/capture-readme.sh` and `git diff --check`.
