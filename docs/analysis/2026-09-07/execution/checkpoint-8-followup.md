# Checkpoint 8 follow-up

Two additional desired-behavior regressions were reproduced after adcf6f292f22edaaf1e9b73ea48a103c74ebe175.

The sandbox adapter allocated its configured 4 GiB tier for a 10 GiB request. It now returns PREFLIGHT_INSUFFICIENT_MEMORY before creating a sandbox, with requested/supported capacity and explicit reconciliation choices. The old warning-only characterization was replaced with a rejection/no-allocation assertion. The adapter and memory utility suites passed 44 tests. This uses the adapter's configured supported tiers, not a newly verified claim about all current Azure offerings. The existing daemon default is 10 GiB, so an unspecified sandbox profile must explicitly reconcile its requirement instead of silently receiving 4 GiB. No live sandbox was allocated.

The native rerun template lost permitted unknown contract extensions because it decoded through the narrower display model. A failing round-trip assertion proved the loss. The dedicated IntentionalRerunDraft now preserves the entire server-validated JSON object, including extension fields and context, while adding the audited rerun decision. Native API, action wiring, and durable draft use that representation. The same regression and full Swift suite passed 335 tests. Native interaction remains unverified.

Continue with required-command/effective-resource probes and execution provenance, then every remaining criterion in the acceptance ledger. No milestone or locally passing suite closes the goal.
