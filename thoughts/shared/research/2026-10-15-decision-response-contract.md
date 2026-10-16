---
date: 2026-10-15
researcher: Codex
git_commit: 3426702dc3bb17d41456ea95829e460046dbe4fc
branch: codex/reliability
repository: autopod
topic: "Shared decision response fixtures and display serialization"
status: complete
last_updated: 2026-10-15
last_updated_by: Codex
---

# Decision response contract

## Existing parity pattern

The checked-in shared/src/fixtures/composable-launch.json request is consumed by
shared schemas/launch-parity.test.ts:6, CLI commands/launch.test.ts:173 and native
LaunchConfigurationTests.swift:63. Tests compare parsed/built/re-encoded request
content. There is no generator/update command or equivalent shared pod-decision
response fixture in the inspected paths. Swift launch decoding rejects unknown
request fields; response DTOs instead use tolerant synthesized Codable.

General CI builds/typechecks/tests all pnpm packages. Desktop CI triggers on
shared/daemon/desktop changes and runs Swift before Node setup. Committed fixture
bytes are therefore consumed directly by Swift, without a generation prerequisite.
See .github/workflows/ci.yml:31 and desktop.yml:8,40.

## Current escalation envelope

Shared types/escalation.ts:9 defines id,podId,type,timestamp,payload,response.
ask_human question/options are nested in payload. Production manager stores that
envelope (for example credential escalation in pods/pod-manager.ts:7041).
Pod.finalization separately has pendingDecisionId and generation/cycle/phase;
completion-journal display mode truncates only result text.

Repository rowToSession parses the stored envelope unchanged
(pods/pod-repository.ts:429). Full detail getOrThrow attaches finalization and the
wire serializer preserves these fields while redacting profile secrets; GET
/pods/:podId uses that route (api/wire-serializers.ts:95, routes/pods.ts:215,719).

Display list paths differ. rowToDisplaySession requires a top-level string
question on pending_escalation (pod-repository.ts:624), whereas the shared envelope
has nested payload.question. Both listForDisplay and listCompactForDisplay use
that sanitizer (:1347–1363). Compact serialization independently reads top-level
pendingEscalation.question (routes/pods.ts:181). Compact SQL bounds escalation
JSON to64KiB before parsing; oversized records get a diagnostic, not dropped pods
(pods/compact-pod-projection.ts). Source therefore rejects a normal nested envelope
as invalid display shape, while direct detail preserves it. This is source-derived
until a route regression is executed.

## Consumer behavior and coverage

Swift EscalationResponse keeps id and nested payload; PodMapper carries question,
options and type into its domain Pod, not decision ID. Compact mapping assigns
pendingEscalationSummary directly to escalationQuestion. FinalizationResponse
preserves optional pending ID and uses it for operator/recovery summaries. See
AutopodClient/Types/PodResponse.swift:6,432, AutopodDesktop/Mapping/PodMapper.swift:98,
112,154,481,494. Optional missing/null keys decode nil; unknown response keys are
ignored; present malformed values or missing required fields fail.

CLI getSession returns a typed Pod after JSON parsing without runtime schema
validation (api/client.ts:335,992). Its status command already reports an unanswered
decision when settlement and pendingDecisionId are present (commands/pod.ts:543).

Existing tests cover independent handwritten data: Swift PodMapperTests.swift:573,
633,711 escalation variants; ReplyDecisionRetentionTests.swift:8 failure/replaced
question behavior; PodMapperTests.swift:1582 null pendingID/artifact preservation;
CLI commands/pod.test.ts:181 non-null pendingID via mock typed client. Daemon route
cases cover compact truncation and malformed/oversized values (pods.test.ts:350,398).
Repository test:555 stores a flattened {id,type,question}, unlike the shared envelope.
No single fixture currently joins production route output to both client consumers.

## Verification and scope

Agent research_cli performed read-only source research. Root checked envelope
shape, both repository list paths, compact SQL/type, route serializer, existing
corruption tests and Swift compact mapping. No production discrepancy was executed
in this research. Preserving decision identity into the UI domain, safe reply replay
and migration of legacy data are separate tasks; no such change is selected here.
