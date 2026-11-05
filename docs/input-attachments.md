# Reference attachments at pod launch

Attach wireframes, screenshots, or HTML and its local assets **without adding them to the target repository**:

```sh
ap run --repo my-app --task 'Implement the attached dashboard wireframe' \
  --attach /private/design/dashboard.html \
  --attach /private/design/dashboard.png

ap run --repo my-app --task 'Use this prototype as the reference' \
  --attach-dir /private/design/dashboard-prototype
```

Both flags are repeatable and work with ordinary task text, `--file`, or `--spec`.
`--attach-dir` preserves the selected folder name and relative asset paths. It
skips hidden entries and dependency/build directories (`node_modules`, `vendor`,
`dist`, `build`, `coverage`). Symlinks, special files, unsafe/colliding paths,
unsupported extensions, and trees exceeding 2,000 entries are rejected.

The macOS **New pod** composer has a Reference attachments section with a file or
folder picker, file-URL drop, image paste, and removable rows. Selection freezes
local bytes; preview uploads and seals them. Launch review displays the exact
manifest and bundle digest. The feature is disabled for daemons that do not
advertise `inputBundles.available`.

## What the worker receives

- `/autopod/inputs/manifest.json`: admitted bundle identity and per-file hashes.
- `/autopod/inputs/files/<relative-path>`: exact reference bytes.
- Generated instructions listing the references and the reference-only boundary.

Provisioning never writes references under `/workspace`, commits them, adds them
to a software image, or publishes them to a PR/screenshot ref/notification. Docker
uses a read-only bind mount. Azure sandbox snapshots are explicitly protected as
root-owned read-only inputs before the worker starts; they are not live host
mounts. A trusted pre-agent command verifies the container's manifest and every
file hash, rejects redirected paths/unexpected entries, and tears down the
container on delivery mismatch. It reads bytes only; uploaded scripts are never
executed by this check. An agent with source-write authority can still deliberately copy a file,
so instructions prohibit doing so unless the task explicitly requests a shipped
asset.

This is separate from `specFiles` / `--include-specs`, which intentionally commit
spec source. Existing `specContextFiles` remain UTF-8 text only; do not put binary
images through the older `--spec` file collector.

## Limits and interpretation

- 50 files; 10 MiB per file; 25 MiB per bundle.
- Portable relative paths, at most 240 characters / 16 segments, at most 240 UTF-8
  bytes per segment, no hidden paths.
- Text/Markdown/HTML/CSS/JavaScript/JSON/YAML/CSV, SVG source, Draw.io XML, PNG,
  JPEG, WebP, GIF, and PDF references.
- Raster headers must declare positive dimensions, at most 16,384 pixels per
  side and 40 megapixels. This is a resource bound, not full image validation.
- Four concurrent binary uploads per daemon. No global HTTP body-limit increase.

**File delivery is not proof of visual interpretation.** The worker is instructed
to use its native image-reading tool and report a blocker if it cannot inspect a
required visual reference. No image payload is silently substituted with base64
text. Actual visual support depends on the selected runtime/model; it is not
qualified merely by uploading a file. PDF/SVG/Draw.io are reference files, not
promises of native rendering.

HTML is **not automatically rendered**. Supply a companion screenshot when visual
appearance matters. Autopod does not execute uploaded scripts or serve HTML in its
authenticated origin. Downloads are inert attachment-disposition octet streams
with `nosniff` and a sandbox CSP.

Independent visual comparison is **not automatic** in this version
(`inputBundles.visualReview: false`). Isolated code reviewers do not receive the
original attachment bytes; a passing code review does not attest to wireframe
fidelity. Safe isolated HTML rendering and a packet-scoped multimodal reviewer
input channel are separate follow-up work, not implied capabilities.

## Identity, recovery, privacy, and retention

Original bytes and manifests are stored in SQLite (migration 236) rather than
large base64 strings in launch JSON. The existing verified SQLite backup therefore
includes originals; filesystem worker copies can be re-created after restore.
Ensure normal DB/WAL/backup disk headroom. Storage is bounded to 250 MiB and 100
bundles per owner and 2 GiB total. Reserved upload sizes count against quota.

Bundle upload keys are owner-scoped and stable for exact retries. Sealing checks
all file bytes against the manifest. Sealed bytes cannot be replaced through the
API. A launch carries only `work.inputBundle: { id, digest, files }`, and the frozen
launch digest binds that exact manifest. Admission checks ownership and pins the
bundle in the same transaction as the pod record.

The CLI saves the exact sealed launch request before submission. After a lost
reply, use its printed `ap run --config <receipt>` command. Do not rerun attachment
flags against changed local files as an exact launch retry. Combining attachment
flags with `--config` requires `--override-config` and creates new preview/launch
identity unless an explicit request key is supplied (conflicting reuse is rejected).

References survive retry/re-provisioning, follow-up/fix/spawn-worker derivations,
and retained pod history. `work.inputBundle: null` explicitly clears inherited
references for a new launch. Series requests may select `inputBundle` at the series
request's top level; current normal pod CLI/desktop attachment pickers do not add
series-picker or phone-uploader support.

Only the authenticated bundle owner can list/download/reuse it. Pod tokens do not
authorize these endpoints. Ordinary pod list/detail DTOs withhold attachment
manifests; the source-configuration endpoint checks attachment ownership. Neither
local absolute paths nor original bytes are included in events or launch receipts.

An hourly sweeper removes unpinned incomplete uploads after one day and unpinned
sealed uploads after seven days. Admission pins intentionally survive parent pod
and container deletion: retained task history or descendants may still need the
references. There is no automatic expiration of pinned originals or destructive
quota-bypass cleanup; storage exhaustion requires an explicit retention decision.
Existing duplicate-work preflight remains conservative (task/contract identity);
changing a wireframe alone does not silently bypass duplicate-work safeguards.

## Upload API

Human/operator bearer authentication is required throughout:

1. `POST /input-bundles` with `{ requestKey: <UUID>, files: [...] }`; each file has
   `path`, `mediaType`, `byteLength`, and lowercase SHA-256. Returns sorted manifest,
   bundle `id`, manifest `digest`, and `status`. Same owner/key/content replays;
   different content conflicts.
2. `PUT /input-bundles/:id/files/:index`, with `Content-Type:
   application/octet-stream` and exact bytes (indices follow the returned manifest).
   Body buffering is capped per file and concurrent uploads are bounded.
3. `POST /input-bundles/:id/seal`; missing or mismatched bytes fail closed.
4. Include the sealed reference (without `status`) in `LaunchRequest.work.inputBundle`.
5. `GET /input-bundles/:id` returns owner-scoped metadata;
   `GET /input-bundles/:id/files/:index` downloads sealed raw bytes.

A replay of an already-sealed file upload succeeds only for the same bytes. An
admitted manifest mismatch, unavailable/corrupt input, unsafe cached copy, or
unsupported storage capability fails explicitly rather than dropping references.
Do not downgrade a daemon with admitted attachment-bearing pods to a binary that
does not understand this contract; older workers cannot preserve these inputs.
