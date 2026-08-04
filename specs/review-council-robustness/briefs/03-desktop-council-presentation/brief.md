---
title: "Present degraded councils and verified fixed findings clearly"
touches:
  - packages/desktop/Sources/AutopodClient/Types/ValidationResponse.swift
  - packages/desktop/Sources/AutopodUI/Models/ReviewCouncil.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ReviewCouncilView.swift
  - packages/desktop/Sources/AutopodUI/Views/Detail/ValidationTab.swift
  - packages/desktop/Tests/AutopodUITests/ReviewCouncilTests.swift
does_not_touch:
  - packages/daemon/
  - packages/cli/
---

## Task

Update Desktop review-council presentation for the new canonical and failure contracts. Healthy councils hide raw first-gate findings. Degraded councils explain the degradation and show unmatched first-gate blockers as fallback evidence. Fixed findings must read unmistakably as verified successes rather than active red defects.

## Required Behavior

- Decode optional batch quality, degradation reasons, typed axis failure, and resolution metadata.
- For explicitly healthy new batches, show canonical structured findings only and no Initial Review section.
- For degraded batches, show a compact degradation banner and unmatched initial records under `First-gate fallback`.
- Render typed axis copy for invalid response, timeout, provider unavailable, runner failed, and HEAD changed; use legacy error copy for historical batches.
- Preserve conservative behavior for historical batches without explicit quality.
- Separate active/regressed findings from fixed findings in the All view.
- In All, render `Needs attention` first and `Fixed in this revision (N)` as a separate disclosure collapsed by default.
- In Fixed, show complete fixed cards grouped by axis.
- Fixed cards use a green check, prominent `FIXED`, green success treatment, neutral historical severity such as `Was HIGH`, and visible verification metadata/evidence when available.
- Regressed remains prominent red; rejected and dismissed remain distinct.
- Counts must agree with the visible canonical/fallback model.
- State must be understandable without color through text, icons, and accessibility labels.

## Constraints

- Do not hide an unmatched initial blocker in a degraded or historical council.
- Do not claim a verified HEAD for historical fixed entries that lack resolution metadata.
- Fixed cards do not expose Dismiss.
- Keep long findings readable at existing detail widths.
- Do not add a new tab or redesign unrelated Validation phases.
- Native SwiftUI/AppKit validation is human review because Autopod-self pods execute in Linux.

## Approved Layout

```text
Review Council                         Degraded council
5 / 5 axes complete                    1 / 5 axes complete

Needs attention (2)                    Council degraded — first-gate
  Security                             fallback findings are included.
  Reliability
                                        First-gate fallback
Fixed in this revision (2)  ▸             [raw bounded blocker]
```

Fixed card:

```text
✓ FIXED    Was HIGH
Finding claim
Verified against HEAD abc1234
Fix evidence: bounded source-backed excerpt
```

## Wrap-up

Update focused Swift model tests. Run Swift tests/build only on a macOS/Xcode-capable environment. Record human review needs clearly, commit, and push before completion.
