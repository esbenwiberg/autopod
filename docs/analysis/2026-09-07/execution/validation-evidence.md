# Exact-input validation evidence

Reuse is off unless the contract explicitly declares a complete, deterministic input boundary. Only successful lint and test phases are eligible. Build, setup, SAST, facts, health/pages and review keep their existing execution and approval rules. A reused phase retains its original receipt, timestamp and duration and has zero new command execution time; it is not a newly executed pass in coverage metrics.

Example YAML (the outer contract key is snake_case; manifest fields are camelCase):

```yaml
validation_evidence:
  version: 1
  hermetic: true
  toolchainFiles: [/usr/local/bin/node]
  dependencyPaths: [node_modules]
  environmentFiles: []
  environmentRevision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The revision must identify the complete declared environment; the example value is illustrative. The contract author must declare every tool, dependency and ignored/generated environment input read by these commands. Time-dependent, random, device-dependent or otherwise unversioned inputs are ineligible. The declaration does not prove that an arbitrary command is hermetic. Runtime reuse additionally requires backend-reported network mode `none`, an immutable image digest, a built validator implementation hash, clean Git status and successful bounded fingerprints before and after lookup/execution. Unsupported sandbox metadata, an incomplete manifest, changed files, input cycles, oversized input sets, probe failures, missing image/build identity or enabled network disable reuse. Capture emits hashes only, not secret contents.

This conservative design intentionally favors extra execution over unsupported reuse. The current local fixture benchmark shows capture overhead dominates short checks; do not enable this for speed without measuring the actual workload. The local backend in the benchmark supplies fixture metadata and executes real Node processes; it is not Docker isolation, a provider receipt or production proof.
