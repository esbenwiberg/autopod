---
name: podsitter
description: Watch and operate recent Autopod pods during unattended runs. Use when asked to `/podsitter`, babysit pods, watch overnight pods, unstick stalled pods, answer pod escalations, approve ready series pods, extend validation or PR fix attempts, waive required-fact deviations, skip or force-approve validation, spawn fix pods, recover failed pods, or manually take over a pod while avoiding unbounded token burn.
---

# /podsitter

One tick of an Autopod operations loop. Protect the user's sleep, token budget,
and branch hygiene. Act only when there is enough evidence to justify the
smallest useful intervention.

## Core Rules

- Reason per pod before acting. Record: evidence, diagnosis, action, stop
  condition, and why this is not just another blind retry.
- Prefer cheap unblockers: answer a question, approve a ready pod, dismiss a
  proven false positive, requeue a lost queued pod, or retry a known infra
  failure.
- Do not extend attempts endlessly. Default to `+1` attempt only. Do not give a
  second rescue for the same failure signature unless the logs show new
  evidence.
- Token spend is a failure mode. If a pod has already had meaningful rework and
  the next action is speculative, stop and report it instead of spending.
- Do not approve, waive, skip validation, or force-complete because you are
  tired of seeing a pod. Use these only when the diff and logs make the risk
  explicit and acceptable.
- Do not let advisory QA harness problems block the queue forever. If
  deterministic validation, required facts, and relevant smoke tests are green,
  and the only `needs_review` finding is that advisory QA used the wrong URL,
  looked at an irrelevant UI surface, or otherwise failed to exercise the
  scenario it was meant to inspect, approve with an explicit reason instead of
  repeating read-only ticks.
- Never hide risk. Operator messages and reasons should say what was inspected
  and what remains unproven.

## State Ledger

Maintain `.autopod/podsitter-state.json` (gitignored) when running in a loop.
Use it to avoid repeating the same rescue all night.

Track at least:

- `podId`
- `lastSeenStatus`
- `lastFailureSignature`
- `actionsTaken`: action, timestamp, reason
- `stopUntilNewSignal`: true when the same action must not be repeated

If no ledger exists, create it after the first tick. If it is unreadable, do one
conservative read-only tick and report the state issue.

## Collect

Start read-only:

```bash
ap ls --json
ap status <pod-id> --json
ap logs <pod-id>
ap logs <pod-id> --build
ap diff <pod-id>
ap series status <series-id>
```

Scope the tick to active pods plus recent failed or review-required pods:

- active: `queued`, `provisioning`, `running`, `awaiting_input`, `validating`,
  `validated`, `approved`, `merging`, `merge_pending`, `paused`
- rescue candidates: `failed` or `review_required` updated recently, or any
  incomplete pod in a watched series
- skip terminal quiet pods unless they are blocking a series or the user named
  them

For each candidate, inspect:

- status, `updatedAt`, `lastHeartbeatAt`, `lastAgentEventAt`, `kickedAt`
- `pendingEscalation`, `pauseReason`, `mergeBlockReason`
- `validationAttempts/maxValidationAttempts`
- `prFixAttempts/maxPrFixAttempts`
- `lastValidationResult`, failed phases, required-fact results
- `readinessReview`, `validationWaiver`, `taskSummary.deviations`
- `seriesId`, parents, dependents, `autoApprove`, `disableAskHuman`
- `costUsd`, `inputTokens`, `outputTokens`, `tokenBudget`
- `worktreeCompromised`, `prUrl`, `fixPodId`, `linkedPodId`

## Decide

Use this order. Stop at the first justified action for a pod unless the action
is purely informational.

| Signal | Preferred action | High bar / stop condition |
| --- | --- | --- |
| Ready validated pod, especially series dependency | `ap approve <id>` or `ap approve --all-validated` | Only auto-approve `ready`. For `needs_review`, read readiness and pass `--reason`. Never bulk-approve `risky` or `waived`. |
| `needs_review` only from advisory QA harness/input mismatch | `ap approve <id> --reason "<validation/facts green; advisory QA mismatch>"` | Use only when build/test/required facts passed and evidence proves the intended path by another deterministic check. Examples: advisory browser QA missed `?demo=1`, inspected a generic app shell instead of the target route, or tried to verify backend/build-tool behavior through UI. Do not approve if the warning names an untested user-visible path with no alternate evidence. |
| `awaiting_input` with `ask_human` | `ap tell <id> "<answer>"` | Answer only from repo/spec/log evidence. If it needs product judgment, report instead. |
| `awaiting_input` with `validation_override` | `ap tell <id> "dismiss 1"` or `ap tell <id> "fix: ..."` | Dismiss only false positives or accepted deviations. Give fix guidance for real bugs. |
| `paused` with `pauseReason: budget` | `ap tell <id> "Budget extension approved: <reason>"` | Approve at most once per pod per sitter run, and only if validation/PR completion is likely cheaper than rerunning later. |
| Queued pod whose dependencies are done and `updatedAt` is stale | `ap kick <id> --reason "queued lost from runner; parents complete"` | Do not kick queued pods still waiting on parents. |
| Running/provisioning pod silent past the watchdog threshold | `ap kick <id> --reason "no agent/heartbeat events since <time>"` | Check recent logs first. After a kick, use `resume` or manual takeover only if worktree evidence is worth saving. |
| Validating pod hung with no phase/log progress | raw API `interrupt-validation`, then reassess | Do not interrupt a long but active test. Prefer waiting over aborting expensive valid work. |
| Review required from deterministic infra failure | Extend validation attempts by `+1` or raw API `revalidate` | Only once per failure signature. Examples: registry outage, runner crash, transient network, reviewer timeout. |
| Review required from real code/test failure | `ap tell <id> "fix: ..."` if awaiting override, or manual takeover | Do not extend validation just to re-run the same failing test. |
| Required fact `pending_human` and fact is impossible/stale | raw API approve fact waiver | Waive only when the contract is wrong or impossible in current reality. Include the exact fact id and evidence. |
| Merge pending with exhausted PR fix attempts | Extend PR attempts by `+1` or raw API spawn-fix | Only if CI/review feedback is new and actionable. Do not loop on the same red CI. |
| PR creation failed after validation passed | raw API `retry-pr` or `resume` | Use when the work validated and only push/PR plumbing failed. |
| Base branch drift or merge conflict likely | `ap update-from-base <id>` | Use for failed/review_required/validating pods with stale base evidence. Stop on conflicts and report files. |
| Missing `gh`/`az` or credentials in running container | `ap install <id> gh|az`, `ap inject <id> github|ado` | Only for explicit tool/auth failures. Never expose credentials in messages or logs. |
| Firewall/network denial blocks a legitimate endpoint | Fix profile/network policy or report | Do not keep retrying inside the pod. |
| Worktree compromised | raw API `recover-worktree`, then reassess | Never approve or force-complete a compromised worktree. |
| Validation is infra-broken but diff is inspected and acceptable | raw API `force-approve`, then normal `ap approve` with reason | Last resort. Record failed phases and manual evidence. |
| Pod is valuable but automation is stuck | raw API `fix-manually`, then `ap attach <workspace-id>` | Use when manual fix is cheaper than another model attempt. Finish with `ap complete <workspace-id> --pr --skip-agent` or revalidate original pod. |
| Pod is not valuable or same failure repeated | leave stopped and report | Saving tokens is success. |

## Operator Actions

Prefer CLI commands when available:

```bash
ap tell <id> "<answer or guidance>"
ap nudge <id> "continue; <specific instruction>"
ap kick <id> --reason "<evidence-backed reason>"
ap approve <id> --reason "<needed for non-ready readiness>"
ap approve --all-validated
ap reject <id> "<specific feedback>"
ap update-from-base <id>
ap validate <id>
ap inject <id> github
ap inject <id> ado
ap install <id> gh
ap install <id> az
```

For daemon actions without CLI wrappers, use the same daemon auth as the CLI.
In development, `~/.autopod/dev-token` is usually enough. In logged-in
environments, `~/.autopod/credentials.json` contains the current access token;
if it is missing or expired, run `ap login` instead of guessing.

```bash
BASE=$(python3 - <<'PY'
import os, re
base = "http://localhost:3100"
path = os.path.expanduser("~/.autopod/config.yaml")
try:
    for line in open(path, encoding="utf-8"):
        m = re.match(r"\s*daemon:\s*['\"]?([^'\"\n#]+)", line)
        if m:
            base = m.group(1).strip()
except FileNotFoundError:
    pass
print(base.rstrip("/"))
PY
)
TOKEN=$(cat ~/.autopod/dev-token 2>/dev/null || python3 - <<'PY'
import json, os
path = os.path.expanduser("~/.autopod/credentials.json")
print(json.load(open(path, encoding="utf-8"))["accessToken"])
PY
)
api_post() {
  local path="$1"
  local body="${2:-{}}"
  curl -sS -X POST "$BASE$path" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body"
}
```

Common raw actions:

```bash
api_post "/pods/<id>/revalidate"
api_post "/pods/<id>/extend-attempts" '{"additionalAttempts":1}'
api_post "/pods/<id>/extend-pr-attempts" '{"additionalAttempts":1}'
api_post "/pods/<id>/retry-pr"
api_post "/pods/<id>/resume"
api_post "/pods/<id>/recover-worktree"
api_post "/pods/<id>/spawn-fix" '{"message":"<new CI/review evidence>"}'
api_post "/pods/<id>/interrupt-validation"
api_post "/pods/<id>/skip-validation" '{"skip":true}'
api_post "/pods/<id>/force-approve" '{"reason":"<manual evidence and remaining risk>"}'
api_post "/pods/<id>/force-complete" '{"reason":"<why no PR/validation path is needed>"}'
api_post "/pods/<id>/fix-manually"
api_post "/pods/<id>/facts/<fact-id>/approve-waiver" '{"reason":"<why the fact is impossible or stale>"}'
```

## Attempt Policy

Use strict sitter budgets even though the daemon allows higher caps:

- validation extension: default `+1`, at most once for the same failure
  signature
- PR fix extension: default `+1`, at most once for the same CI/review signature
- budget extension: at most once per pod per sitter run
- kick: once per pod unless it returns to a different stuck state
- skip validation / force approve / force complete: last resort, never repeated

Failure signature should include enough to detect repeats: status, failed phase,
top error line, merge blocker, fact id, PR check name, or escalation type.

## Series Pods

For series, think about the graph:

1. Check `ap series status <series-id>`.
2. Approve ready validated parents so dependents can start. Also approve
   `needs_review` parents when deterministic validation/facts passed and the
   only warning is an advisory QA harness/input mismatch; record the evidence in
   the `--reason`.
3. Kick only dependents whose parents are already complete enough for their PR
   mode.
4. Do not skip or waive a parent just to unblock a child unless the parent diff
   has been inspected and the risk is acceptable for all downstream pods.
5. If one parent is bad, stop the series and report the blocker instead of
   spending on dependents that will inherit the bad base.

## Output

Always close the tick with a compact dashboard:

```markdown
Podsitter - <time>

| pod | status | diagnosis | action | next stop |
| --- | --- | --- | --- | --- |
| abcd1234 | awaiting_input | asked whether to use existing helper; repo confirms yes | answered via ap tell | wait for progress |
| efgh5678 | review_required | same lint failure after 3 attempts | no action | needs human/manual fix |
```

Include:

- actions taken and exact reasons
- pods intentionally left alone to save tokens
- pods needing the user
- ledger updates made

If everything is quiet, say so and do not invent work.
