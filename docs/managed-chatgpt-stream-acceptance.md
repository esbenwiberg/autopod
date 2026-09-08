# Managed ChatGPT report stream extraction

Status: locally tested; corrected live artifact acceptance remains **BLOCKED**.
The managed lane stays disabled by default.

The pinned ChatGPT transport can return HTTP 200 and a completed output item
while its final `response.completed.response.output` is an empty array.
Diagnostic canary 016 observed one completed output item and 444 UTF-8 report
bytes in both deltas and that item, but zero terminal output items or bytes.
The terminal model matched the exact route; reported usage was 17,821 input
plus 102 output tokens. These are endpoint diagnostics, not an accepted artifact
or durable provider-usage receipt. The request journal remained reserved.

The transport now accepts schema-valid completed items when terminal output is
empty. Each item must have a unique bounded ID and a contiguous output index.
Messages must have completed status and the assistant role; tool output is
refused. Text deltas alone never establish a report. A populated terminal output
must agree with the completed items, including any supplied IDs. Duplicate or
late items and multiple terminal completions fail closed.

The existing single terminal completion, exact model, usage-sum, live authority,
1 MiB stream, 16 KiB report and 64 KiB worker-response checks remain mandatory.
There is no request retry, route fallback or change to hard-token transports,
grants, migrations, schemas, source-delivery authority or the disabled default.
This internal extraction change adds zero voice turns, clarifications, approvals
or routine interruptions; existing 35-word launch and 45-word completion budgets
and the separate live voice/device acceptance boundary are unchanged.

## Evidence and next gate

Canary 016 used immutable candidate archive SHA256
`664ebc1cff6c225b357a5ba52e96d81b0bb4294fdbb90a61a7aa8478fe624192`,
which predates this fix. It made exactly one generation request on
`openai-private` / ChatGPT / Codex / `gpt-5.6-terra` / Sandbox. No artifact was
exported and no Blob request occurred. Native state was preserved; the exact
temporary Sandbox was deleted and absence observed. Do not use this receipt as
acceptance of the corrected source.

Local regression tests reproduce the empty-terminal failure and conflicting
output acceptance before the fix, and cover valid completed items, reasoning,
UTF-8, IDs, indexes, role/status, tool output, deltas-only output, oversize output,
duplicate completions, conflicts and revoked authority. Full daemon and
cross-language validation results belong in the coordinating publication record.

Next external step: independently review and publish the patch, build a new
immutable candidate from that exact source, then run one fresh bounded canary
and independently verify the report and immutable Blob artifact. Until those
checks execute successfully, corrected live provider/artifact acceptance is
**BLOCKED**. General activation, source delivery and live voice/device acceptance
remain separate gates.
