---
title: "Attach screenshots to ADO PRs (fix dead links)"
depends_on: [01-add-screenshot-store]
acceptance_criteria:
  - { type: cmd, test: "! grep -nE 'buildGitHubImageUrl' packages/daemon/src/worktrees/ado-pr-manager.ts", pass: "exit 0 — ADO PR manager no longer constructs GitHub URLs", fail: "ADO is still building GitHub URLs (the dead-link bug)" }
  - { type: cmd, test: "grep -nE 'buildAdoAttachmentRef|adoAttachmentUrl|/_apis/git/repositories/.*/pullRequests/.*/attachments' packages/daemon/src/validation/screenshot-collector.ts packages/daemon/src/worktrees/ado-pr-manager.ts", pass: "exit 0 — at least one of the files contains the ADO attachment plumbing", fail: "no provider-aware ADO URL builder is wired in" }
touches:
  - packages/daemon/src/worktrees/ado-pr-manager.ts
  - packages/daemon/src/worktrees/ado-pr-manager.test.ts
  - packages/daemon/src/validation/screenshot-collector.ts
  - packages/daemon/src/pods/pod-manager.ts
does_not_touch:
  - packages/daemon/src/pods/screenshot-store.ts
  - packages/daemon/src/db/migrations/
  - packages/daemon/src/api/routes/
  - packages/daemon/src/notifications/
  - packages/daemon/src/validation/report-generator.ts
  - packages/daemon/src/worktrees/pr-manager.ts
  - packages/desktop/
---

## Task

Fix the dead-screenshot-link bug on Azure DevOps PRs. Today,
`screenshot-collector.ts` constructs `https://github.com/...` URLs
via `buildGitHubImageUrl` and the same `screenshotRefs` object is
passed to both PR managers (`pod-manager.ts:6608`). On ADO repos,
the GitHub URL 404s.

The fix: when the pod's repo is ADO, upload each PNG to the ADO PR
attachments endpoint and embed the returned attachment URL in the
PR body. GitHub's path stays exactly as today.

### Provider detection

`screenshot-collector.ts` (or the pod-manager site that calls it —
whichever has the provider context) chooses URL builder based on
the pod's git provider. Detection precedent already exists; reuse
it (`pod-manager.ts:6608` and `pr-manager.ts` know whether the pod
is GitHub or ADO — typically inferred from the remote URL or a
profile field). Do NOT add a new provider-detection helper from
scratch; trace where the existing one lives.

### ADO PR attachment upload

Microsoft's REST API:

```
POST /_apis/git/repositories/{repositoryId}/pullRequests/{pullRequestId}/attachments/{fileName}?api-version=7.1
Content-Type: application/octet-stream
Body: <raw PNG bytes>
```

Response includes `url` (attachment URL) and `_links.self.href`. The
`url` field is what the PR-body Markdown should reference as the
image source.

Two integration points:

1. **PR creation time** — in `ado-pr-manager.ts:createPr` (and
   `updatePr` if it ever rewrites screenshot bodies), upload each
   `ScreenshotRef` *after* the PR is created and *before* the body
   is rendered. The PR ID isn't known until creation, and the
   attachments endpoint is PR-scoped — so the order is:
   create-PR-with-no-screenshots → upload-attachments → patch-PR-
   body-with-attachment-URLs. If the existing `createPr` flow
   already does a similar two-pass (create then update), match it;
   otherwise this brief introduces the two-pass pattern for ADO.

2. **Bytes source** — read PNGs via `screenshotStore.read(ref)`. The
   collector (after brief 01) returns `ScreenshotRef[]`, not bytes.
   Pass the store into `ado-pr-manager` via constructor injection
   the same way the rest of the daemon's repositories are wired.

Authentication: ADO PR APIs use the same PAT the rest of
`ado-pr-manager.ts` uses today (search for the existing
`Authorization` header construction — typically `Basic` with a
`:<pat>` username). Match it.

### Failure stance

If the attachment upload fails (network error, 5xx, expired PAT):

- The PR is still created (already true — creation comes first).
- The PR body falls back to omitting the screenshot section, OR
  emits a `_screenshots failed to upload — see daemon logs_`
  marker. Pick one and document it in the source comment.
- Log a warning. Do not throw — the pod's primary deliverable (the
  PR) is intact.

This matches the existing `commitFiles` failure stance for the git
path (`design.md` → Reference reading: "Falls back gracefully if
the upload fails").

### `screenshot-collector.ts` rewire

Today the collector unconditionally returns refs with GitHub URLs
baked in. After this brief:

- The collector returns `ScreenshotRef[]` (from brief 01) without
  any URL field. URL generation moves to the **renderer** (the
  PR-body builder / pod-manager call site), which knows the
  provider.
- Add `buildAdoAttachmentRef(ref, attachmentUrl)` (or a renaming
  that drops the misleading "Url" suffix from the existing GitHub
  helper) — whatever shape lets `pr-body-builder.ts:276` switch on
  provider and produce the right `<img src="...">` (GitHub) or
  Markdown image (ADO) for each screenshot.
- The existing `buildGitHubImageUrl` stays — it's correct for
  GitHub.

### `pod-manager.ts` call site (line ~6608)

The single line that passes the same `screenshotRefs` object to
both PR managers becomes provider-aware:

- For GitHub: build refs with GitHub URLs as today.
- For ADO: pass `ScreenshotRef[]` (no URL) into `createPr`; the ADO
  manager uploads + injects URLs into the body.

Keep the change minimal — this brief should not refactor
`pod-manager.ts:6608` beyond what's required to pass provider-
appropriate data into each PR manager.

## Touches

- `packages/daemon/src/worktrees/ado-pr-manager.ts` — attachment
  upload, two-pass PR creation, body rewrite with attachment URLs.
- `packages/daemon/src/worktrees/ado-pr-manager.test.ts` — mock
  the ADO attachments endpoint and the PR creation, assert the
  two-pass order and the body content.
- `packages/daemon/src/validation/screenshot-collector.ts` —
  remove unconditional GitHub URL construction; collector returns
  raw refs.
- `packages/daemon/src/pods/pod-manager.ts` — provider-aware
  branch at line ~6608.

## Does not touch

- `packages/daemon/src/pods/screenshot-store.ts` — brief 01.
- `packages/daemon/src/db/migrations/` — no schema change.
- `packages/daemon/src/api/routes/` — brief 02-api.
- `packages/daemon/src/notifications/` — brief 02-api.
- `packages/daemon/src/validation/report-generator.ts` — brief
  02-api.
- `packages/daemon/src/worktrees/pr-manager.ts` — GitHub flow
  unchanged. Do not refactor it for symmetry; one provider's bug
  is being fixed, not both.
- `packages/desktop/` — brief 03.

## Constraints

From `purpose.md` → Non-goals: "No change to the branch-commit
flow for smoke screenshots." `pod-manager.ts:6537-6541` keeps
committing `.autopod/screenshots/` to the feature branch. Do not
remove that path. The committed images are what GitHub PR
reviewers see; they remain the source of truth for that provider.

From `purpose.md` → Non-goals: "No change to GitHub PR-body
rendering." The GitHub URL builder, the body rendering, and
`pr-manager.ts` are out of scope. Touching them is overreach.

From `design.md` → ADO attachment flow: "If the upload fails, the
PR is still created (no screenshots in body) and a warning is
logged." Match this exactly.

## Test expectations

`ado-pr-manager.test.ts`:

- **Happy path.** Create PR with two `ScreenshotRef`s. Mock the
  ADO API: PR creation returns ID 42, two attachment uploads
  succeed and return URLs `https://dev.azure.com/.../42/<n>`. The
  PR body update call carries Markdown image references to those
  exact URLs.
- **Two-pass order.** Confirm PR creation is the FIRST API call,
  and attachment uploads happen AFTER (PR ID is required).
- **Upload failure.** One of the two attachment uploads returns
  500. The PR is still created (creation call happened). The body
  update either omits the failed screenshot or emits the marker
  text. A warning is logged. The function does NOT throw.
- **Auth.** Confirm the attachment POST carries the same
  `Authorization` header the existing PR creation calls use.
- **No-screenshot pods.** A pod that produced zero screenshots —
  no attachment calls fire; the PR body is built without a
  screenshots section. Confirms the path is gated correctly.

`screenshot-collector.test.ts`:

- The collector returns `ScreenshotRef[]` with NO URL field
  populated. URL generation now lives downstream.

`pod-manager` smoke (existing e2e if present):

- Wire a pod with `provider: 'ado'` and confirm the ADO PR
  manager receives raw refs (and uploads them). Wire one with
  `provider: 'github'` and confirm the existing GitHub URL flow
  still fires.

## Risks / pitfalls

- **PR ID dependency.** The attachment endpoint requires the PR
  ID. If `createPr` today is single-pass, this brief introduces a
  two-pass flow. Walk
  `packages/daemon/src/worktrees/ado-pr-manager.ts` end-to-end
  before designing the upload sequence — there may already be an
  `update`-after-`create` pattern to mirror (e.g. for setting
  reviewers).

- **Filename uniqueness on ADO.** ADO attachments are scoped to
  the PR by `{fileName}`; uploading two with the same name to the
  same PR replaces the first. The store filenames are already
  unique within `(podId, source)` (page slug for smoke, AC index
  for ac, array index for review). Concatenate the source bucket
  to the upload filename to avoid collisions across buckets:
  `smoke-root.png`, `ac-0.png`, `review-0.png`.

- **PAT scope.** The ADO PAT used by autopod must include
  `vso.code_full` (or the equivalent attachments scope). If
  uploads 401/403 in real usage but the PR creation succeeds, the
  PAT scope is the most likely culprit — call this out in the
  log message so users have a hint.

- **Body Markdown for ADO vs GitHub.** ADO renders
  `![alt](url)` and `<img>` differently from GitHub. The existing
  `pr-body-builder.ts` uses `inlineImages: false` for ADO
  (`ado-pr-manager.ts:206`). Read the rendering branch before
  deciding whether the new attachment URLs slot into the existing
  branch or need their own. The minimal change: keep the
  existing branch, swap the URL source.

- **Concurrency on uploads.** Uploading 5 PNGs serially is fine.
  Don't `Promise.all` them — ADO rate-limits attachments and a
  parallel burst can fail half. Sequential or `pLimit(2)` is the
  safe choice. The latency is noise compared to the rest of pod
  validation.

- **The provider detection seam.** Find where the codebase
  currently knows "this pod is ADO" vs "this pod is GitHub" —
  it's likely a profile field or a derived helper. Reuse it.
  Don't sniff the remote URL with a regex inside this brief.

## Wrap-up

1. Run `/simplify` and address findings.
2. `npx pnpm --filter @autopod/daemon test` — passes.
3. `npx pnpm build` — passes.
4. Manual smoke: spawn an ADO pod with smoke screenshots, let it
   create the PR, open the PR in the ADO web UI — confirm the
   screenshots render inline (not 404).
5. Manual smoke: spawn a GitHub pod with smoke screenshots,
   confirm the PR body is unchanged from before this brief
   (regression check).
6. Commit and push.
