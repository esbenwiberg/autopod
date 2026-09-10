# Checkpoint 137: approved amendment and final closure

The user explicitly approved the immediately preceding proposed amendment:

> September 7 history/cost failure cause remains unknown because the required logs were not retained; current API behavior is verified.

The approval prompt was “Do you approve that specific amendment?” and the user replied “approve”. This is the specific scope change previously required for W4.5, rather than an inference from broad rollout authority. [Approval receipt](receipts/checkpoint-137-user-amendment.json).

The isolated branch's [contract copy](../goal-prompt.md) now appends this amendment and retains the original wording as historical context. The unrelated original checkout is untouched. Only the historical-causality prerequisite changes. The [ledger](acceptance.json) preserves the original requirement and earlier partial receipts, records W4.5 as accepted_with_amendment with historicalRootCause=unknown, and verifies the final closure criterion G.6. There are 42 verified criteria, one explicitly accepted amended criterion and no outstanding required acceptance. All six workstreams are complete under the amended contract.

Product source and deployed release remain `425ff91cd5e6347b32d21b69804ea4c02008bc8e` as verified in CP136. Full validation passed 6,390 package tests, one existing platform skip and 11 standalone Node tests, with the required pipeline gates and supported operator evidence retained at their recorded source boundaries. CP136 proves the hosted rollout, fresh backup/restore, successful MCP summary, budget persistence/pause, immutable image provenance, owned sandbox cleanup, restored dispatch and stable daemon. [Full validation identity](receipts/checkpoint-135-full-validation-identity.json), [hosted evidence](checkpoint-136.md). No further runtime change or canary was needed for this documentation-only amendment.

Residual limitations remain explicit in the [final closure report](closure-report.md): the historical API cause is unknown; budgets stop further work at observed accounting boundaries and may be exceeded by an in-flight turn; exact provider/infrastructure billing is unavailable; the local matched benchmark did not support the 25% speed target; one moderate dependency advisory and the existing platform skip retain their original scope. Prior failures and failed cleanup bounds are not rewritten as successes. Publication is on the approved implementation branch; no main merge is claimed.

Closeout verification checks ledger dispositions and scope, linked final receipts, unchanged product source, and documentation whitespace. The final contract, ledger, report, release packet and approval receipt are committed and published together. The goal may now be marked complete without claiming the missing historical diagnosis was proved.
