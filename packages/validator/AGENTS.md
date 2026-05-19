# @autopod/validator

`@autopod/validator` generates Playwright validation scripts and parses their
results. It is intentionally thin: execution belongs to the daemon, not this
package.

Keep inputs and outputs typed with `@autopod/shared`. Add parser and generation
edge cases beside the implementation as `*.test.ts`.

Useful checks:

```bash
npx pnpm --filter @autopod/validator test
npx pnpm --filter @autopod/validator typecheck
npx pnpm --filter @autopod/validator build
```
