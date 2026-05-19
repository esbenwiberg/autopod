# @autopod/e2e

`@autopod/e2e` is reserved for end-to-end checks that exercise the system from a
user-level boundary. Keep broad smoke flows here; keep package-level behavior in
co-located unit tests.

The current package is a placeholder, so do not add assertions here unless the
flow truly needs multiple packages or a running daemon.

Useful checks:

```bash
npx pnpm --filter @autopod/e2e test
```
