# Per-pod sandbox compute estimates

Work → Cost contains one per-pod card: a total, the model cost bar and the existing
Work/Rework/Validation/Advisory/Unattributed rows, followed by Resources for Azure
sandbox pods, tokens and model. Task → Task budget contains the ordinary editor;
Task retry limits and existing Recovery controls retain their operational actions.
The reference image was inspected visually; it is not a shipped source asset.

`GET /pods/:podId/cost` optionally adds `resourceCost` with `state` (`estimated`,
`partial`, `unavailable`), nullable `estimateUsd` and nullable ISO
`observationCutoff`. Docker omits it. Old clients ignore it; old daemons still
decode, with sandbox Resources shown as Unavailable. The model subtotal and
buckets, task infrastructure accounting, and linked repair accounting are unchanged.
The native card adds unrounded usable resource estimates to the model subtotal;
partial/missing resource or material model coverage gives a Known total.

## Evidence and observations

Migration 273 adds an independent ledger keyed by provider group scope and exact
sandbox ID, with an immutable owning pod. It retains compact totals by allocation
and versioned rate provenance plus the last observation. No foreign-key cascade
removes it on replacement, cleanup or archival. Same-ID resume adds intervals to
the same allocation; distinct attributable IDs retain independent totals.

The Azure adapter reuses GET responses from lifecycle polling, status reads and
resource inspection. State, response ID and actual CPU/memory quantities must be
verified together; no tier, agent, phase or pod runtime is a usage measurement.
Unsupported quantities or states are unknown. There is no supported transition
timestamp in the current adapter response contract, so accounting uses observation
receipt times. This is a sampling estimate, not exact metering.

The sampler targets 30 seconds, with one request in flight and the adapter's
bounded retry/backoff. It reads only recorded sandbox IDs in the configured
group and previously tracked live allocations, including retained resources.
It never starts, resumes, stops or deletes anything. Confirmed terminal IDs stop
sampling. Failures in accounting are logged independently from workload actions.
No runtime configuration or paid canary is required.

Only consecutive Running observations at most 90 seconds apart are fully priced.
A short Running/stopped or confirmed terminal bracket uses its midpoint. Confirmed
stopped intervals are free. Unknown/failed observations, changed allocations and
long gaps break continuity; daemon startup inserts an unknown boundary for tracked
allocations. There is no extrapolation after the last observation, no historical
backfill and no settlement from DELETE 202. The first observation, even if
stopped, does not establish earlier usage. Stopped-only observations show
Unavailable, not $0. Once there is priced Running time, the amount is partial
because coverage before discovery remains unknown. Replays/out-of-order samples
are ignored; terminal evidence cannot be reopened by a late response. GET cost
reads durable evidence only and does not contact Azure.
Live evidence whose cutoff is more than 90 seconds old is also partial; the
displayed amount remains fixed until another verified interval is recorded.

## Rate assumption and settings

The configured `AZURE_LOCATION` must be exactly `northeurope` or `swedencentral`
for the pinned v1 public USD active Consumption rates. Unknown regions stay
unavailable. Existing subscription/resource-group/sandbox-group settings identify
the scope; accounting has no separate billing credentials or configuration knobs.
Sampler cadence (30s) and maximum bracket (90s) are intentionally fixed bounds.

The supplied Azure Retail Prices API observation on 2026-11-21 found one Standard
active CPU and memory meter per supported region, effective 2022-06-01:

| Region | CPU meter ($0.000024/vCPU-s) | Memory meter ($0.000003/GiB-s) |
| --- | --- | --- |
| northeurope | 4ebd2e58-3f2c-58a5-a442-8460e472dce7 | c43d1f5d-5a92-5222-80a3-228227a1ddd8 |
| swedencentral | 4ea1c35d-d999-57d0-88f2-e689d3475fcd | 05396e31-2622-5cc8-9bb4-06d0ac9c6047 |

Each priced interval contributes to a compact bucket that pins version, meters,
region, allocation, effective/retrieval dates and unit rates. Future rate changes
must use a new version/bucket rather than repricing old evidence.

Microsoft's [Sandbox overview](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview)
states that stopped sandboxes incur no CPU/memory fees. Its
[Consumption pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
states that Sandboxes follow Consumption pay-per-second pricing. Applying the
active retail meters to observed Running allocation is an explicit estimate
assumption. It excludes Docker, storage, transfer, discounts, free grants and
billing integration; it is not invoice equivalence.

## Verification

The supplied checkout baseline matched `efafb0dee8b1896c1c83ec20160413c43ef527b8`;
no authenticated refresh was attempted. The required fake-time ledger and HTTP
contract checks are in `sandbox-compute-cost.test.ts` and `integration.test.ts`.
Swift decoding and presentation checks are in `PodCostBreakdownResponseTests.swift`,
with a partial Resources preview in `SessionCostCard.swift`.

Linux cannot compile or render SwiftUI/AppKit. Native checks are NOT RUN and must
be executed on the final committed source SHA by Mac/CI:

```sh
bash scripts/test-desktop.sh
```

On that Mac, inspect the Session Cost preview and Work → Cost against the supplied
image, including legacy sandbox Unavailable, partial estimates and Docker with no
Resources row. No native visual-fidelity result is claimed by Linux checks.
