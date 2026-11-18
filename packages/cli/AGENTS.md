# @autopod/cli

`@autopod/cli` is the Commander-based `ap` client. It should stay thin: parse
flags, call daemon APIs, render useful terminal output, and keep durable state in
the CLI config store only.

`draft-pr` is inspect-only by default. Preparation, exact confirmation and
read-only observation are separate daemon calls. Keep the supplied request ID
and binding; never retry an uncertain write or infer approval from a draft
receipt. See `docs/saved-work-draft-pr.md`.

Commands live in `src/commands/`. Shared API types should come from
`@autopod/shared`; do not import daemon internals into the CLI.

Useful checks:

```bash
npx pnpm --filter @autopod/cli test
npx pnpm --filter @autopod/cli typecheck
npx pnpm --filter @autopod/cli build
```
