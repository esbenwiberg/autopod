---
title: "Redact pod task body from runtime spawn logs and container exec logs"
touches:
  - packages/daemon/src/runtimes/claude-runtime.ts
  - packages/daemon/src/runtimes/codex-runtime.ts
  - packages/daemon/src/runtimes/copilot-runtime.ts
  - packages/daemon/src/containers/docker-container-manager.ts
  - packages/daemon/src/runtimes/claude-runtime.test.ts
  - packages/daemon/src/runtimes/codex-runtime.test.ts
  - packages/daemon/src/runtimes/copilot-runtime.test.ts
  - packages/daemon/src/containers/docker-container-manager.test.ts
does_not_touch:
  - packages/daemon/src/index.ts
  - packages/daemon/src/runtimes/claude-stream-parser.ts
  - packages/daemon/src/runtimes/codex-stream-parser.ts
  - packages/daemon/src/runtimes/copilot-stream-parser.ts
  - packages/daemon/src/runtimes/run-claude-cli.ts
---

## Task

Stop the daemon from dumping the full pod task / resume-message string into
its logs. Three runtime spawn-log call sites and three container-exec log
call sites currently serialize the entire `args` / `command` array, whose
final-or-second element is the user-supplied task. When a task contains a
large pasted blob (e.g. Lottie/Bodymovin JSON, base64 image, big spec), the
daemon terminal gets flooded with a single-line wrap-the-window log entry.

The fix is targeted, not global: each runtime replaces the task element it
already knows the index of with the literal string `<task: N bytes>` before
passing the log object to pino; `docker-container-manager.ts` applies a
generic length-based replacement (`<arg: N bytes>` for any element over
1 KB) at log time only. The real exec keeps receiving the unredacted
command — only log records change.

## Why

A single pod whose task description contains a Lottie JSON paste filled the
user's daemon terminal window with a wrapped JSON blob and made the log
unreadable. The existing pino redact config at
`packages/daemon/src/index.ts:103-106` only masks credential-shaped fields
by path — it does no length capping, and there is no path-based rule that
would catch a long task string buried inside an `args` array. Stream
parsers already slice stderr to 500 chars and tool output to 2000 chars
(see `claude-stream-parser.ts:76,129,177`); the spawn-args path is the
last unbounded leak.

We chose targeted truncation over a global pino serializer because the
leak surface is small (4 files, ~7 log calls), and a global string-cap
serializer would silently chop diffs, validation output, AI review notes
and stack traces — exactly the strings we want to see in full when
debugging real incidents.

## Touches

- `packages/daemon/src/runtimes/claude-runtime.ts` — sanitize the `args`
  field at the `info` log inside `spawn()` (`:75-81`). Task is at the last
  index (`args.push('--', config.task)`, `:407`). Resume at `:190` does not
  currently log `args`; leave it alone.
- `packages/daemon/src/runtimes/codex-runtime.ts` — sanitize the `args`
  field at the spawn log (`:32-38`) AND the resume log (`:104-108`). Task /
  follow-up message is at index 1 in both: `['exec', config.task, ...]` at
  `:182` and `['exec', message, ...]` at `:102`.
- `packages/daemon/src/runtimes/copilot-runtime.ts` — sanitize the `args`
  field at the spawn log (`:58-64`). Task is at index 1
  (`['-p', config.task, ...]` at `:222`). Resume re-spawns via the same
  spawn path, so a single fix covers both.
- `packages/daemon/src/containers/docker-container-manager.ts` —
  sanitize the `command` field at all three log call sites: `:540` (warn,
  `exec.inspect timed out`), `:546` (debug, `Exec completed`), `:645`
  (info, `Streaming exec started`). Use a generic length-based pass:
  any element whose string length exceeds 1024 is replaced with
  `<arg: <length> bytes>`. Keep the real `command` array intact for the
  actual exec — only the logged copy is redacted.
- Co-located `.test.ts` files for each — add the test cases described in
  *Test expectations*.

## Does not touch

- `packages/daemon/src/index.ts` — leave `PINO_BASE_OPTIONS` and the
  `LOG_REDACT_PATHS` list as-is. This brief is a targeted fix, not a
  global pino reshape.
- `packages/daemon/src/runtimes/{claude,codex,copilot}-stream-parser.ts` —
  these already truncate stdout/stderr/tool-result content. Out of scope.
- `packages/daemon/src/runtimes/run-claude-cli.ts` — separate helper used
  outside the pod-spawn path; verified it does not log `args`.
- `AgentEvent` shapes or message-content slicing inside any runtime. The
  fix is at log-record-construction time, nowhere else.

## Constraints

- **Runtimes know their task index; DCM does not.** Each runtime replaces
  the task element by index (last for claude, `1` for codex/copilot)
  *before* it builds the log object — do not push this responsibility down
  to DCM. DCM applies a generic length-based replacement because it
  receives `command: string[]` blindly and cannot know which element is
  semantically "the task".

- **Redaction marker shape** — runtimes log `<task: <bytes> bytes>` for
  the task position; DCM logs `<arg: <bytes> bytes>` for any element it
  flags by length. Two different markers so a reader can tell which layer
  did the redaction. `<bytes>` is `string.length` (char count, not byte
  count of an encoded form) — consistent with how the existing `.slice(0,
  N)` calls in stream parsers count.

- **DCM threshold is 1 KB (`> 1024`).** Anything at or under 1024 chars
  passes through untouched. A small enough threshold that pasted JSON
  blobs get caught; large enough that ordinary flags
  (`--append-system-prompt-file /home/autopod/.autopod/system-instructions.md`)
  are never elided.

- **Do not mutate the original arrays.** Build a fresh array for logging
  (`const safeArgs = args.with(taskIdx, marker)` or
  `command.map(a => a.length > 1024 ? marker(a) : a)`). The real
  `args` / `command` passed to `containerManager.execStreaming` /
  `dockerode` must remain untouched.

- **Existing runtime tests assert on the real `args` passed to
  `execStreaming`** (e.g. `claude-runtime.test.ts:85-94` expects the
  exact unredacted task string in the args sent to the mock container
  manager). Those assertions must remain green — the new log redaction
  must not leak into the array we hand to `execStreaming`.

- **Resume log in `claude-runtime.ts:190` already excludes `args`** — do
  not "fix" it by adding an `args` field there. Codex's resume log at
  `:104-108` does include `args` and needs the same redaction as spawn.

## Skills to reference

None. This brief does not match any auto-detection skill
(`/add-profile-field`, `/add-pod-state`, etc.) — no profile field, no
new pod status, no state-machine edits.

## Test expectations

Unit tests, co-located per-file, mocked logger. The harness for each
runtime already wires a mock `Logger` and a mock `ContainerManager` —
extend the existing test setup.

- `claude-runtime.test.ts` — new test in the spawn-args block:
  - Spawn with `config.task` set to a ~50 KB string (e.g.
    `'X'.repeat(50_000)`).
  - Assert `logger.info` was called once for `'Spawning claude in
    container'` and the `args` field on that call's first argument is an
    array whose last element matches `/^<task: 50000 bytes>$/`.
  - Assert the 50 KB string is **not** present anywhere in the logged
    object (sweep with `JSON.stringify(call.args[0]).includes(bigStr)`
    expecting `false`).
  - Assert the real `args` passed to `containerManager.execStreaming` still
    contains the full 50 KB string at the last index — i.e. the runtime
    did not mutate the array, only the log copy.
- `codex-runtime.test.ts` — two cases, same shape as claude but task is
  at index 1:
  - Spawn case: 50 KB `config.task`, assert logged `args[1]` matches
    `/^<task: 50000 bytes>$/`; real exec args unchanged.
  - Resume case: 50 KB `message` to `resume()`, assert logged `args[1]`
    matches the same shape (line `:104-108` log).
- `copilot-runtime.test.ts` — spawn case mirroring codex (task at index
  1). Resume goes through spawn, no separate case needed; add a comment
  in the test naming why.
- `docker-container-manager.test.ts` — two cases against `execStreaming`:
  - Long-arg case: call `execStreaming(id, [shim, 'claude', '--flag',
    'X'.repeat(50_000)], opts)`. Assert the `'Streaming exec started'`
    log's `command` field has the long element replaced with
    `<arg: 50000 bytes>` and the other three elements pass through
    verbatim.
  - Small-arg negative case: call with a command whose longest element is
    < 1024 chars; assert `command` is logged verbatim, byte-equal to the
    input array. This prevents the redaction from over-firing.
  - Also extend (or add, if not already covered) cases for the `:540`
    (exec.inspect timeout) and `:546` (exec completed) call sites in the
    non-streaming `exec()` method — same long-arg assertion shape.

## Risks / pitfalls

- **Resume-path drift.** Claude's resume log (`:190`) does not currently
  log `args` and is intentionally left out of scope. If someone later
  adds `args` to that log call without redacting, the leak returns. The
  test in `claude-runtime.test.ts` for the resume path should assert
  that the resume-log call's first argument has no `args` field at all
  (defensive snapshot of current shape).

- **Threshold tuning.** 1024 was picked because real task strings vary
  from a few hundred chars to multi-KB, and a Lottie blob easily clears
  100 KB. If a brief author later writes a legitimate ~2 KB task, the
  DCM log will show `<arg: 2048 bytes>` instead of the body — that is
  intended (the runtime-level log shows it more meaningfully), but worth
  remembering when debugging.

- **Marker collision.** A pathological user task string equal to
  `<task: 1234 bytes>` would round-trip identically. We accept this as a
  non-issue — markers are diagnostic, not authoritative.

- **Future runtimes.** Any new runtime added later (e.g. a fourth
  agent) must remember to redact its task element before logging
  `args`. This is a recurring shape and a candidate for a shared helper
  later; for now, three copies of the same two-line transformation are
  fine — abstraction now would be premature.

## Wrap-up

Before finishing:
1. Run `/simplify` and address its findings.
2. Re-run build and tests; both must still pass.
3. Commit and push.
