# ADR 002: Store artifacts on filesystem, not SQLite

## Context

On completion, `/workspace/` contents need to be accessible for the files API and desktop.
Options: store file contents as blobs in SQLite (like validation screenshots), or extract
to a host directory.

## Decision

Extract to `<dataDir>/artifacts/<sessionId>/` on the host filesystem. Store the path in
`session.artifactsPath`. The existing `files.ts` route logic (walk + serve) works unchanged
by pointing it at this directory.

## Consequences

- Files survive daemon restarts without DB bloat
- Large artifacts (many files, binaries) are handled naturally
- Cleanup needed when sessions are deleted (acceptable — can be deferred)
- Artifact files are not replicated inside the daemon process memory
- SQLite-stored validation screenshots remain as-is (small, embedded)
