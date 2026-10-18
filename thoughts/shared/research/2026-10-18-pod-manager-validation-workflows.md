# Slice 20 research: validation workflows

Date: 2026-10-18. Baseline: 5c20dde639cd5c7297bc861952cb6a3ab87fb820.
Research captured before implementation. Isolated branch clean at entry.

The manager has 16,369 lines after Slice 19. Ordinary validation is :12317–13419;
human-driven revalidation :13421–13975. Seven public methods belong to the validation
workstream, including extension, cached override, interrupt, update-from-base and
skip controls. Three mutable collections coordinate abort, coalesced extensions and
pending base-update intent. Kill/watchdog/delete also retain references to these
collections. Existing extracted components supply validation admission, inputs,
execution retries, evidence, publication, progress, provenance and advisory QA.

The ordinary flow includes force rework/provisioning, source preservation, sandbox
status recovery, validation execution, ownership checks, history/publication, independent
retry-finding council, skip/fact/infrastructure handling, PR delivery, advisory QA,
agent correction and outer error parking. The revalidation flow intentionally differs:
it pulls human changes, tolerates pull failure only with force, can requeue a missing
container as validation-only, builds its own reviewer context and fails without agent
correction. Preserving these distinctions requires separate complete owners.

The methods use dynamic this calls. triggerValidation calls triggerValidation,
assertCanRework, approveSession, consumeAgentEvents and handleCompletion. Revalidation
calls approveSession. Extension and update-from-base call triggerValidation, including
fire-and-forget callbacks. Binding these to construction-time methods would change
late replacement/receiver behavior. Original deps reads in these owners are confined
to launchConfiguration.read/goals.get and pendingOverrideRepo.flush; other dependencies
are captured manager-local references. Source analysis and exact reference/type output
are retained in the task-local evidence folder.

The trigger method has 1,103 lines and embeds PR-delivery policy. Moving it as one
function avoids new asynchronous stage boundaries; the plan explicitly reviews this
intermediate size and assigns delivery removal/size review to milestone 27. All plans
continue toward the complete 20–34 roadmap, not helper-only completion.

Baseline evidence: Slice 19 passed 95 affected suites (3,368 tests), full uncached
8,539 Vitest cases plus 35 script checks, ten existing gated skips. These are inherited
results; Slice 20 results must be gathered from its final source. No live provider,
browser, Docker/Azure execution or integration/deployment follows from local tests.
