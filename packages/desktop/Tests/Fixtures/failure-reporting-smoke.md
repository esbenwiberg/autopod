Mac validation for the exact candidate SHA recorded in residential-cod's task summary

All native checks below are NOT-RUN in the Linux worker. Keep the configured
independent gates; these instructions are not a substitute or waiver.

1. Check out the exact candidate and run:
   `swift test --package-path packages/desktop --no-parallel --filter FailureReportingProjectionTests`
   and `swift test --package-path packages/desktop --no-parallel --filter OverviewFailureReportingTests`.
   Then run `./scripts/test-desktop.sh` (or the Desktop workflow) on that candidate.
2. Use the native test fixtures' synthetic `residential-cod` pod and saved multiline
   reason (>500 characters, leading spaces, trailing tab/newline, TAIL-SENTINEL).
   Host Overview and the reason panel at 320 points and at normal width in both
   Desktop presentations. Verify wrapping, vertical scrolling and visible tail;
   no horizontal clipping or truncation. Confirm lifecycle badge remains visible.
3. Select reason text with mouse and keyboard, extend selection across line breaks,
   and copy. Tab to the labelled Copy reason button and activate with Space.
   Paste into a plain text editor and compare the full payload, including leading
   whitespace, line breaks and the trailing sentinel/tab/newline. Check VoiceOver
   exposes the label and selectable text.
4. Exercise compact discovery, full hydration, equal/older compact, then newer
   compact with a delayed/failed full request. Copy must disappear while current
   full detail is unavailable. A current replacement appears verbatim; current
   null shows confirmed absence without Copy. Socket error text never becomes the
   reason. Repeat after a status/attempt transition and switching pod/connection.
5. Compare ordinary Test failed, typed timeout, runner crash and process memory
   exhaustion in failed/review-required pods. Killed stays neutral with or without
   a saved reason despite old failing checks. Skipped/advisory and stale results
   do not supply a cause. Verify execution inspection, compromised worktree and
   fix delivery warnings retain their titles/guidance and take precedence; the
   review-required card does not repeat the saved reason.
