# Proof-of-Work Screenshots

## Problem

Validation screenshots — Playwright smoke pages, `validate_in_browser` per-AC
checks, and AI task-review artefacts — are stored as base64 PNG strings inside
JSON columns on the `validations` row. The daemon's SQLite database is **107 MB
on disk today** and grows monotonically as pods accumulate validation attempts
(one observed pod hit "Rework 2 — Attempt 5 of 5" with multi-page captures per
attempt). There is no time-based or count-based retention; only foreign-key
cascade on pod delete.

The desktop app clamps thumbnails to 200–300 px in `ScreenshotThumbnail.swift`
and `SummaryTab.swift`'s proof-of-work card, with no click-to-zoom path. Full-
resolution PNGs are sitting in the JSON blob but reviewers cannot examine them.

ADO PR descriptions render dead screenshot links: `screenshot-collector.ts:56`
only emits `https://github.com/...` URLs (`buildGitHubImageUrl`), and the same
`screenshotRefs` object is passed to both PR managers (`pod-manager.ts:6608`).
ADO repos get GitHub URLs that always 404.

## Outcome

Reviewers can examine pod validation evidence at full resolution from the
desktop, and the daemon DB stops growing with screenshot data.

## Users

- **The user** running pods locally — primary beneficiary of the desktop
  full-resolution UX and the smaller DB.
- **PR reviewers on GitHub** — already see screenshots via committed branch
  files; this feature does **not** disturb that path.
- **PR reviewers on Azure DevOps** — currently see dead links; this feature
  fixes them via PR attachment uploads.
- **Teams card recipients and HTML report viewers** — keep receiving inline
  base64 images; the daemon reads-and-encodes from disk at notify/render time.

## Success signal

Three observable signals, each tied to a brief AC:

1. After upgrade, the daemon's `validations.screenshots` column writes are gone
   from `validation-repository.ts` — no base64 strings flow into SQLite.
   *(Brief 01 AC.)*
2. The daemon JSON API returns screenshot URLs instead of base64 in pod /
   validation responses. *(Brief 02 AC.)*
3. After the configured retention period, terminal-state pods have empty
   screenshot directories under `<dataDir>/screenshots/<podId>/`.
   *(Brief 02-prune AC, validated by the retention sweep's unit tests.)*

The desktop lightbox UX is reviewer-judged via the screenshot's existence + Test
expectations — no `web` AC is possible against a native macOS app.

## Non-goals

- **No capture-side resolution bump.** Playwright stays at 1280×720 viewport,
  1x DPR, `fullPage: true`. DPR / viewport tuning is a separate spec.
- **No backfill of legacy SQLite blobs.** Drop-on-cutover semantics: pods that
  ran before this ships will show "no screenshots" in the desktop UI. The
  migration must snapshot the DB before running so this remains rollback-able.
- **No change to the branch-commit flow for smoke screenshots.**
  `pod-manager.ts:6537-6541` keeps committing `.autopod/screenshots/` to the
  feature branch so github.com PR reviewers continue to see them.
- **No change to GitHub PR-body rendering.** GitHub URLs already work; only the
  ADO path is being fixed.
- **The daemon-served screenshot endpoint stays loopback-only.** It is for the
  desktop app on the same host, not a public asset host.
- **Workspace pods are unaffected.** They have no agent and no validation, so
  no screenshots flow through them.
- **Validate-in-browser tool wire shape** is internal to the daemon. The agent
  never reads the screenshot field — only `passed` / `reasoning`. So changing
  it from base64 to a path token is invisible to the agent.

## Glossary

- **Proof-of-work screenshot** — a PNG captured during pod validation as
  evidence of agent or validator behaviour. Includes (a) Playwright smoke-page
  captures, (b) `validate_in_browser` per-AC web-UI check captures, (c) AI
  task-review screenshots. Excludes intermediate-state captures from the
  agent's transcript that aren't surfaced in the Validation / Summary tabs.
- **Screenshot store** — the on-disk directory `<dataDir>/screenshots/<podId>/`
  on the daemon host, sibling of `<dataDir>/artifacts/`. Survives worktree
  cleanup; deleted only by the retention sweep or pod deletion.
- **Source bucket** — subdirectory under a pod's screenshot dir indicating
  capture origin. Three values: `smoke`, `ac`, `review`.
- **Cutover migration** — the one-shot migration `091_drop_screenshot_blobs`
  that NULLs `validations.screenshots` and removes embedded `screenshotBase64` /
  `screenshot` / `taskReview.screenshots` fields from `validations.result`.
  Drop-on-cutover: pre-cutover pods lose UI screenshots permanently.
- **Retention period** — days a terminal pod's screenshots persist on disk
  before the sweeper deletes them. Default 30, configurable via env var
  `AUTOPOD_SCREENSHOT_RETENTION_DAYS`.
- **Terminal state** — `complete`, `killed`, or `failed` (per state machine in
  `state-machine.ts`).
- **Lightbox** — in-app modal overlay in the desktop app showing a screenshot
  at full resolution, with arrow-key navigation between sibling screenshots in
  the same set (set = one validation attempt's screenshots).
- **Set** — the bag of screenshots from a single validation attempt across all
  three source buckets, used to scope lightbox arrow-key navigation.

## Reversibility

The cutover migration drops a column and rewrites JSON blobs in `validations.
result`. This is hard-to-reverse without a snapshot.

**Mandatory pre-migration step**: the migration runner must copy the live DB to
`packages/daemon/backups/<timestamp>-pre-screenshot-cutover.db` before running
`091_drop_screenshot_blobs.sql`. The existing backup directory at
`packages/daemon/backups/` is the precedent.

**Rollback procedure**:
1. Stop the daemon.
2. Restore the snapshot DB to replace `autopod.db`.
3. Revert daemon code to the commit prior to brief 01 landing.
4. Revert desktop code to a build that consumes base64 (older builds will not
   be able to render URL-shaped screenshot responses from a new daemon).
5. Restart daemon.

After rollback, base64-in-DB resumes serving the old desktop. Any screenshots
captured between cutover and rollback are lost (they were written to disk by
the new code, but the old code does not know how to read them). This is an
acceptable cost for a tool with a single-user blast radius.
