# Repository preparation evidence

`repository.setup.prepareCommand` runs after checkout and scoped registry setup,
before coding starts. It is repository-owned: projects must declare their Python
modules, dependency installation and project browser revision there. A missing
command retains legacy startup behavior and records `not-configured`; it does
not establish repository readiness.

Execution provenance includes an optional `repositoryPreparation` observation:
`not-configured`, `passed`, `failed` or `unverified`. Historical records without
the field remain unknown. The observation is bound to the container, worker
identity, actual image/resource metadata when available, command/configuration
hashes, HEAD and a fingerprint of current source inputs. Unknown image or resource
metadata remains explicitly unknown. Launcher discovery and global-tool probes
do not prove project imports, project browser launch or full runner readiness.

Preparation requires a positively observed zero exit. Failures, timeouts, unknown
exits, unavailable source observations and changed inputs prevent coding or checks
from starting. Failure detail is bounded and sanitized; credential-bearing lines,
URLs, shell traces, resolved secret values and command literals are withheld.
Unknown validation execution retains the existing termination and retry gates.

The bounded source probe hashes tracked files and nonignored untracked files,
without running Git filters or hooks. It supports at most 30,000 files, 64 MiB of
regular-file content and 16 MiB per file; unsupported inputs fail closed. Ignored
installation/build outputs are excluded. Preparation must leave source and lock
inputs unchanged; generated installation outputs should follow repository-owned
ignore rules. Coding checks the fingerprint again immediately before runtime
dispatch. Each independent/final validation invocation runs preparation again
inside its existing retry/dispatch admission; no cached readiness certificate is
reused for a later candidate.

Workers are instructed to serialize install, typecheck, build, test and browser
workloads within admitted memory/CPU limits and prefer a repository-owned serial
verifier. This guidance does not enforce scheduling of provider-native Bash tools.

Validation reports exit 137 or a trailing `Killed` as `PROCESS_KILLED`, a
nonretryable process/resource failure. It does not prove OOM: a child can send
itself SIGKILL. The current execution metadata does not expose trustworthy cgroup
OOM evidence, so that evidence is reported unavailable. Explicit native heap or
allocation errors retain their memory-failure classification.

The Node 22/24 Playwright bases and PostgreSQL variants include Python venv and
ensurepip support, checked as the runtime user. Source tests do not prove an
image has shipped. Use the [disposable Docker qualification recipe](../templates/base/qualify-node-playwright.md)
for native image proof; production image publication and digest updates are separate.
