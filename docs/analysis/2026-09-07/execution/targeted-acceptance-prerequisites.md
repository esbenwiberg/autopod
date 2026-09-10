# Targeted remaining acceptance prerequisites

**CP129 update:** the approved full-window import succeeded. Sandbox creation returned 400; the task-owned image was deleted and absence verified. No runtime checks ran. The [label-safe additional-attempt proposal](label-safe-image-canary-packet.md) supersedes the consumed request; exact rejection cause remains unconfirmed.

**CP128 update:** the corrected request was approved and used once. ACR exchange succeeded; the image PUT hit an erroneous local 60-second timeout. No task resource was observed in repeated inventories through/past the ten-minute window. The [full-window proposal](full-window-image-canary-packet.md) replaces this consumed request; hidden conversion remains uncertain and no retry is authorized.

**CP127 update:** data reads work. Approved CP126 import was refused with HTTP 401. The [corrected additional-attempt request](corrected-image-canary-packet.md) replaces its missing-token request; no new role grant is established as necessary.

**Current CP126 update:** PIM restored data-plane reads. The ready same-repository image has an older digest. The [exact image packet](exact-image-canary-packet.md) supersedes the historical access/canary prerequisites below; its paid execution remains unapproved.

**Current status (checkpoint 125): Section A was approved and completed in checkpoint 110. It is retained below as a historical payload description, not a new approval request.** The affected image is now pinned to dataverse-harness digest `sha256:4b836cdabc71ffd40aef564b65b6b16564c5312770130bc59251a732078c9d77`. Sections B/C still require access and a finalized separately approved canary. The September 10 checkpoint-125 fresh data-plane GET still returned 403. The current principal cannot grant roles; see the [exact administrator handoff](sandbox-access-handoff.md). Actual hosted snapshot/candidate upgrade passed; no copy-execution approval remains pending. The current [release packet](release-and-acceptance-packet.md) supersedes stale source and prerequisite statements below.

Latest update: [checkpoint 110](checkpoint-110.md) fulfills the targeted hosted read, pins the affected sandbox image and records the release-label/dirty-checkout mismatch. Native UI interaction now works: a real failed-reply bug was reproduced and fixed. The application candidate has changed after the old 90a61141 packet; full validation and remaining native acceptance continue. No sandbox/role/publication/deployment authority is implied.

Checkpoint 109 fulfilled the approved runtime discovery. It established the configured sandbox group, one current profile image digest and historical disk-full errors. It did not establish the historical API cause, affected profiles' images or canary access. Section A describes the already fulfilled approval. Sections B and C describe separate remaining prerequisites; the completed approval did not grant roles or authorize a paid canary.

## A. Completed: one focused read on the pinned VM

[Exact payload](fixtures/inspect-targeted-acceptance-metadata.py), pinned in [the manifest](receipts/checkpoint-109-targeted-manifest.json). It was locally tested, explicitly approved and executed once in checkpoint 110.

Target: VM `autopod-daemon`, immutable VM ID `3addc9bc-4812-4892-98d6-c40d5ab893c0`, subscription `06bb959b-9458-41a6-bdf5-77cc12feaab9`, resource group `ewi-sandboxes`. Recheck ARM identity before one Azure Run Command invocation. Guest time limit 60 seconds, exported JSON at most 3,500 bytes. Additional provider/sandbox spend **$0**; existing VM billing continues.

Export only:

- The service PID, exact release directory, checkout SHA/dirty boolean and bounded command exit metadata. Derive the release from the service cwd; permit only `/opt/autopod/releases/<8-to-40-hex>/packages/daemon`. Set Git's `safe.directory` for this one command and this exact release, disable external diff/text conversion, hooks, fsmonitor and optional locks. No persistent Git setting or repository write. This resolves a possible ownership-related read refusal; a successful checkout read still does not attest every loaded bundle byte.
- Read-only profile name, parent, execution target, runtime and warmed-image reference for **`luumi`, `dataverse-harness`, `teamplanner-pr-read`**, then their named parent chains, at most nine visited names total and ten seconds of SQLite work. These are the three profiles named in the original ownership/registry evidence. Match `/data/autopod/autopod.db` device/inode `2049/13107203` and a service FD first. No repositories, prompts, task text, provider account, credentials or full profile objects. A current profile is dated current configuration, not proof of the historical execution binding. Missing/invalid/truncated inheritance is unresolved.
- September 7 00:00–24:00 UTC journal aggregates: at most 10,000 lines, 2 MiB and ten seconds. Count fixed SQLite/JSON/disk/response-size/other-error classes, fixed missing-column/table/disk-full/locked/corruption details and first/last timestamps. Classify only `/pods` and `/pods/analytics/cost`, stripping query values. Count fixed 200/500/other status categories. Correlate an error lacking a route only with the same process ID and request ID within 30 seconds and only when the route is unambiguous. Request IDs, raw logs, arbitrary error messages, stacks, SQL identifiers and row content remain in VM memory and are never exported. Report parse/read/transport omissions. Correlation supports investigation; it does not automatically establish root cause.

No database/service/source modification, environment export, sandbox access, role grant, deployment, restart, provider call or lifecycle mutation is included. This payload does not reuse or expand the already-consumed checkpoint-108 approval.

## B. Access prerequisite: sandbox data-plane read currently forbidden

One read of disk-image metadata at the configured group returned `Forbidden`. The direct/inherited assignments returned for the current CLI user are Contributor and Azure ContainerApps Session Executor. Group memberships were not included, so the inventory does not prove the complete effective role set. The actual 403 does prove this attempted request was refused.

Configured group scope:

```text
/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.App/sandboxGroups/autopod-spike-neu
```

The documented role for sandbox operations is **Container Apps SandboxGroup Data Owner**, definition `c24cf47c-5077-412d-a19c-45202126392c`. It grants read/write/delete/action data permissions under sandbox groups. An administrator can supply an appropriately authorized identity or grant the needed access at the narrow group scope. No assignment was made or requested for automatic execution. Contributor is not substituted for the refused data-plane request. See [Microsoft's prerequisites](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview#prerequisites) and [the queried definition](receipts/checkpoint-109-sandbox-role.json).

With data access available, recheck only the relevant disk-image digest labels and state; select an existing matching ready disk image. Do not run `ensureDiskImage`, because that helper can create an image and garbage-collect others. If no matching image exists, prepare and price an explicitly scoped import; do not allocate one to finish discovery.

## C. Canary preparation and remaining limits

The actual service configuration is `autopod-spike-neu` / `northeurope` / registry `ewiautopodacr.azurecr.io`. The retained `autopod-self` profile uses Codex and `ewiautopodacr.azurecr.io/autopod/autopod-self:latest`, which resolved to `sha256:50cad20e0085219a1cc442301c8cd476b8f33ba397b3fdfc7d43d36283461259`. **Do not substitute it for an affected-profile image.** Section A supplies those current profiles before selecting the required actual-image canary.

Proposed resource envelope remains one disposable sandbox, one creation attempt, no model/provider calls, explicit L resources of 2 vCPU / 4 GiB / 40 GiB disk, at most five minutes allocated through cleanup. This is a proposed tier consistent with the source default, not an observed live allocation. Do not silently resize if the intended affected profile requires different resources. A lost creation response is an unresolved resource; never issue a second creation attempt. Cleanup must be restricted to the exact created identity and verified absent. A local timer is not an Azure billing cap or proof of deletion.

Microsoft's current [Container Apps pricing page](https://azure.microsoft.com/en-us/pricing/details/container-apps/) states that Sandboxes use Consumption Plan pricing. The [North Europe retail receipt](receipts/checkpoint-109-retail-prices.json) records $0.000024 per vCPU-second and $0.000003 per GiB-second. Without assuming free grants or discounts, five minutes at 2 vCPU / 4 GiB is `300 × (2 × 0.000024 + 4 × 0.000003) = $0.018` compute. That is **not a total quote or a hard spend cap**. Resolve image conversion/storage/transfer implications and any allocation/cleanup overrun before the paid-canary request. No tariff is borrowed from Dynamic Sessions.

The final executable packet must pin the affected image/disk-image identity and exact commands/oracles: effective upload/exec/streaming users; actual Codex CLI path/version; granted CPU/memory; real upload plus candidate `runtimeConfigInstallCommand` with a non-secret sentinel and atomic replacement; and observed streaming chunks/exit. No ownership privilege change to force a pass. For the relevant .NET profile, identify whether a separate actual image is required before extending the one-sandbox envelope. Use the candidate's supported NuGet list/help/package-search semantics and only an approved feed/auth scope. Existing local execution tests remain evidence for command construction, not live-image capability.

Visible native interaction and intended deployed-source provenance remain separate acceptance requirements. The local 90a61141 source and full-validation receipts remain unchanged. The goal is incomplete.
