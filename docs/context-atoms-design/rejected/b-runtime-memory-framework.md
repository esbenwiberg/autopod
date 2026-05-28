# Rejected: Adopt a runtime memory framework (Letta / Mem0 / Zep / Cognee)

## What they are
External agent memory systems with their own runtimes.
- **Letta (MemGPT)** — full agent runtime with OS-inspired tiered memory (core / recall / archival).
- **Mem0** — bolt-on memory library, hybrid vector+graph+kv, self-edits on conflict.
- **Zep** — async server with temporal knowledge graph; understands state changes over time.
- **Cognee** — graph-first; build the KG before any queries.

## Why they looked attractive
- Production-ready memory layers with extraction pipelines.
- Hybrid vector + graph retrieval, self-edit-on-conflict, telemetry, benchmarks.
- We'd inherit a mature solution instead of building.

## Why we rejected
- **All require a daemon or service.** Violates the tool-neutrality requirement — colleagues without that service can't read the memory.
- **Their primary use case is conversation memory** (user said X yesterday), not repo-local intent. Different shape of problem; the metrics they optimize aren't ours.
- We already own the approval workflow (in autopod) and want it tightly coupled to PR review. External frameworks don't enforce that.
- **Storage is private to the framework.** Atoms-as-markdown lets ANY tool participate; runtime frameworks lock you in.
- Empirical evidence is mixed. The AGENTS.md study suggests the underlying mechanism (push extracted context into the prompt) may backfire regardless of which framework implements it — see `../../premortem/context-atoms.md` failure mode 3.1.

## What would change our mind
- A framework releases a repo-local, file-backed mode with no daemon dependency AND a permissive license.
- Our own infrastructure cost exceeds the framework's price for equivalent value.

## Provenance
Web research turn (Mem0 / Letta / Zep / Cognee comparison), chat with Esben 2026-05-28.
