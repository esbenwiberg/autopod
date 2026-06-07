---
title: "Expose compact Readiness in existing CLI/API flows"
touches:
  - packages/cli/src/client.ts
  - packages/cli/src/commands/pod.ts
  - packages/cli/src/commands/session.ts
  - packages/cli/src/commands/session.test.ts
  - packages/cli/src/commands/pod.test.ts
does_not_touch:
  - packages/daemon/src/pods/pod-manager.ts
  - packages/desktop/
  - packages/daemon/src/worktrees/pr-body-builder.ts
---

## Task

Expose Readiness through existing CLI workflows without adding a new command.

Add:

- `ap status <id>` compact Readiness output;
- `ap approve --reason "..."`;
- approve-all skipped pod output.

Do not add `ap readiness <id>` in v1.

## Touches

- `packages/cli/src/client.ts` - include `reason` in approve requests and accept
  approve-all skipped pod responses.
- `packages/cli/src/commands/pod.ts` - show compact Readiness in detailed status
  output if this is where `ap status <id>` lives.
- `packages/cli/src/commands/session.ts` - add `--reason` to approve and render
  approve-all skipped pods if this is where approve lives.
- CLI command tests - cover reason parsing, status output, and approve-all
  skipped rendering.

## Does Not Touch

Do not create a dedicated `ap readiness` command. Do not change PR body output.
Do not implement daemon readiness computation or approval rules in the CLI.

## Constraints

- CLI displays only compact readiness information, not a full raw evidence
  bundle.
- If a pod has no snapshot, show a clear unavailable/pending line instead of
  failing.
- `--reason` is optional at CLI parse time; the daemon enforces when it is
  required.
- Approve-all should tell the operator which pods were skipped and why.

## Output Shape

Example `ap status <id>` line:

```text
Readiness: needs_review - 2 findings before approval
```

Example approve-all output:

```text
Approved: abcd1234
Skipped:
  efgh5678 needs_review - Advisory QA concern
  ijkl9012 risky - validation failed; pass --reason for manual approval
```

## Test Expectations

- `ap approve <id> --reason "accepted denied egress"` sends `reason` to the
  daemon client.
- `ap approve --all-validated` prints skipped readiness rows when the daemon
  returns them.
- `ap status <id>` prints compact Readiness when present.
- `ap status <id>` prints Readiness unavailable/pending when absent.

## Wrap-up

Before finishing:

1. Run focused CLI command tests.
2. Run `npx pnpm --filter @autopod/cli test`.
3. Commit and push.
