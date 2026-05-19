# @autopod/shared

`@autopod/shared` is the dependency foundation for the monorepo. Keep it free of
heavy runtime dependencies and never import daemon, CLI, validator, or MCP code
from here.

Types live under `src/types/`, one file per concern. Public exports flow through
`src/index.ts`. When changing shared types, check every downstream package that
consumes the contract.

Useful checks:

```bash
npx pnpm --filter @autopod/shared test
npx pnpm --filter @autopod/shared typecheck
npx pnpm --filter @autopod/shared build
```
