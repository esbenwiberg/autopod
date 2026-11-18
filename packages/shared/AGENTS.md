# @autopod/shared

`@autopod/shared` is the dependency foundation for the monorepo. Keep it free of
heavy runtime dependencies and never import daemon, CLI, validator, or MCP code
from here.

Types live under `src/types/`, one file per concern. Public exports flow through
`src/index.ts`. When changing shared types, check every downstream package that
consumes the contract.

Saved-work draft contracts intentionally use a separate operation/receipt from
Pod status and `prUrl`. Their review-only human authority must never be mapped
into ordinary approval, readiness or merge/fix polling.

Useful checks:

```bash
npx pnpm --filter @autopod/shared test
npx pnpm --filter @autopod/shared typecheck
npx pnpm --filter @autopod/shared build
```
