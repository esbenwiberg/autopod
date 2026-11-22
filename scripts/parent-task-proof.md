# Offline parent Task trial proof (v1)

```sh
node scripts/parent-task-proof.mjs EXPECTED.json CAPTURE.json RELEASE.bundle
node --test scripts/parent-task-proof.test.mjs
```

This is a verifier for a **captured, successful delegation-on trial shape**: one
normal Task parent attempt, two coding children it requested, one retained
integration, and one owner-approved **private review download**. Reconnects,
extra children, alternative bundle formats and other delivery routes are outside
v1. A missing or unsettled milestone does not pass. Exit 0 means the supplied
statements, signatures and Git objects are consistent; the JSON output always
contains `provenance: "not-established"` and `liveAcceptance: false`. Rejection
prints a reason to stderr, emits no success output, and exits 1.

Use Node 22+ and trusted local Git from `PATH`. The verifier reads only the
three operator-selected files. It uses a disposable private bare mirror under
`TMPDIR` (or the OS temp directory) to import objects and inspect them, without
checking out files, running bundle code, installing refs or using Git configuration
from the caller. It removes the mirror on normal return or error. There are no
API calls, credentials, workload launches, or writes to the capture or external
systems.
Use a disposable resource-limited host with untrusted packs: a compressed size
and command timeout are not an expanded disk or memory quota.

## Capture format

This is a normalized **offline** envelope, not a daemon response body. Retain the
underlying sanitized captures separately. Do not put credentials, credential
bearing URLs, Git configuration or live resource access in any input. Metadata
must be UTF-8 JSON (and have no duplicate keys); all named fields are required and
extra fields are rejected. `sha256:<64 lowercase hex digits>` denotes a digest
except `launchDigest`, which is the native bare 64-digit launch preview digest.
Commit and tree IDs are full 40-digit lowercase SHA-1 Git object IDs.

**`EXPECTED.json`** (8 KiB limit):

| Field | Value |
| --- | --- |
| `version` | `1` |
| `run`, `parentId` | Intended run and admitted Task pod ID, recorded independently of the submitted proof |
| `requestId`, `launchDigest` | Lowercase launch UUID and exact preview digest from the guarded Task launch |
| `repository`, `sourceCommit` | Enrolled repository ID and exact accepted starting commit |
| `policyDigest`, `ownerActorDigest` | Frozen combined gate-policy digest and enrolled approval principal digest |
| `requestKeys` | Two distinct expected parent request keys, in gate input order |

Freeze expectations before collecting proof: retain the reviewed launch and
source/policy pins from the trial design, then bind the assigned run and pod ID
from the intended admission observation. Do not fill the expected values from
the evidence file under review. A local expectations file is not self-authenticating.

**`CAPTURE.json`** (256 KiB limit), with `version: 1` and these fields:

| Field | Required data |
| --- | --- |
| `parent` | `origin: "task-launch"`, `run`, `podId`, `requestId`, `launchDigest`, `attempt`, `generation` (nonnegative integer from the session), `runtimeId`, and `exit`. Normalize from the admitted launch, bound runtime session and exit evidence, not the Task card/status. |
| `children` | Exactly two `{reservation, exit, candidate}` records in gate input order. The `reservation` joins the originating parent request to the admitted child and holds `origin: "parent-runtime"`, `run`, `parentId`, `parentAttempt`, `parentGeneration`, `requestKey`, `startKey`, `installationId` (`native.<run>`), `podId`, `attempt` (child dispatcher attempt ID), `executionSpecDigest`, and `runtimeId`. The `candidate` is the unmodified daemon `SourceCandidateReceipt` for the private child. |
| `manifest` | The **exact canonical JSON string** of the retained qualified custody manifest, not a newly composed payload. Contains native `version`, `subject`, `bundleDigest` and `verification` with the full gate request, combined policy, and both signed receipts. Limit 16 KiB; gate request limit 8 KiB. |
| `preview`, `approval` | Native private review preview and approval response objects. Approval has `review`, `approvalDigest`, `approvedAt` (positive integer epoch seconds). |
| `download` | `run`, `parentId`, `evidenceDigest` (from the download selector), `commit` (from the response filename), `httpStatus` (`200`), `bundleDigest` (response `x-autopod-bundle-digest`). Preserve the response body unmodified in `RELEASE.bundle`. |
| `effects` | Exactly `push`, `pullRequest`, `merge`, `deploy`, `acceptedSourceAdvance`; each is `{status: "not-performed", evidenceDigest}` with an observation reference. `unknown`, `success`, extra effects and missing records do not pass. Absence of a log is not a `not-performed` observation. |

Each `exit` contains `run`, `podId`, `attempt`, `runtimeId`, `status: "observed-exit"`,
`exitCode: 0`, `observer` (`provider-runtime` or `daemon-runtime`), and
`evidenceDigest` referring to the specific per-attempt exit observation. Preserve
actual exit events, not reservation acknowledgments, stop requests, inferred exit
codes, or terminal UI status. `runtimeId` is an opaque printable runtime identifier
(use a stable sanitized alias across records if needed).

**`RELEASE.bundle`** (64 MiB limit): the complete SHA-1 v2 Git bundle with a
single detached `HEAD` and no prerequisites. The verifier checks the measured
bytes against the retained and released digest, imports the objects, and checks
actual integration commit/tree, ordered child commits and their trees, and each
child's direct parent against the pinned starting commit. It verifies the two
role-bound passing Ed25519 statements against the captured policy whose digest
must match the independent pin. Approval hashes and exit/effect digest references
are not signatures. The tool does not re-run checks/review, verify the referenced
exit/effect records or child transport bytes, or rebuild the daemon's live custody
DB joins. `parent-task-proof.test.mjs` contains a complete synthetic producer for
this format using an actual tiny fictional bundle and ephemeral test keys.

For any separately authorized real trial, an operator would still need to check
origin and custody from authenticated daemon/provider records: original guarded
admission, the actual runtime attempt's parent request, child allocation and exit
evidence, qualification and owner approval/download, and observed side effects.
A fabricated, mutually consistent metadata set or fixture-signed policy is not
proof those events occurred. Preserve unknown outcomes as unknown; do not relabel
them to get a passing proof.

## Matched delegation on/off capture

Plan the pair before measuring. Use isolated runs from **the same repository,
commit/tree, objective and inputs**. Keep the same parent provider/model/account
route, runtime/image/settings, and allowed actions apart from the delegation
switch. On uses the enrolled children; off has the parent do the same work without
child allocation. Record actual admitted routes and any drift. Apply identical
check recipe/version, independent review route and rubric, and output criteria to
each arm's **exact** chosen commit/tree (including the same expected scope and
review-ready artifact form). The output commits need not be identical. Use a
separate private artifact for off if the enrolled private download mechanism is
unavailable there; do not count an off-arm artifact as the enrolled release. Record
any mismatch and label the pair not comparable when requirements differ.

Record both arms side by side, with source references and units:

- **Elapsed:** same monotonic clock definition from Task admission to the selected
  output and both check/review decisions available. Record queue/provision, work,
  gates, retries and human approval/release waits separately. Do not substitute
  completion time or subtract overhead for only one arm. Unfinished runs have no
  observed completion time.
- **Quality:** per-criterion result, check and review outcome, the exact evaluated
  commit/tree and artifact digest, and defects/rework or missing outputs. Retain
  unsuccessful or incomplete runs rather than selecting only winners.
- **Overlap:** where relevant, record observed child runtime start/exit intervals
  on a common clock, separately from reservations and waits. For two children,
  overlap is `max(0, min(exit times) - max(start times))` only with all four
  observations. Use `not applicable` for off once zero children is established;
  use `unknown` for incomplete observations or incompatible clocks.
- **Usage/cost:** capture parent, child, reviewer and infrastructure usage with
  units and reporting source; include retries, any unallocated usage, currency and
  price/rate basis. Separate billed costs from estimates. Record absent values as
  `unknown` with a reason, not zero; distinguish observed zero from not applicable.

Keep these comparison records beside the proof, not in the strict verifier input.
Report the measured values and caveats, not a speedup claim, estimate of what the
other arm would have done, or inference from an offline verification pass.
