# Brief 04: CLI — ap research command

## Objective

Add `ap research <profile> <task>` command. Derives mount paths automatically from URL last
segment. Follows the `ap workspace` pattern in `packages/cli/src/commands/workspace.ts`.

## Dependencies

- Brief 01 (types: `CreateSessionRequest.referenceRepos`, `referenceRepoPat`)

## Blocked By

Nothing downstream in CLI.

## File Ownership

| File | Action | Notes |
|------|--------|-------|
| `packages/cli/src/commands/research.ts` | create | New command file |
| `packages/cli/src/index.ts` | modify | Register `registerResearchCommands` |

## Interface Contracts

Consumes: `CreateSessionRequest.referenceRepos`, `referenceRepoPat`, `outputMode: 'artifact'`

## Implementation Notes

### packages/cli/src/commands/research.ts

Model on `workspace.ts`. Key differences:
- No `--branch` flag (branch is auto-set to `research/<id>` by daemon)
- Add `--repo <url>` repeatable flag → `referenceRepos`
- Add `--repo-pat <token>` flag → `referenceRepoPat`

```ts
program
  .command('research <profile> <task>')
  .description('Run a research agent — produces artifacts instead of a PR')
  .option(
    '--repo <url>',
    'Read-only reference repo to clone into the container (repeatable)',
    (val: string, acc: string[]) => { acc.push(val); return acc },
    [] as string[],
  )
  .option('--repo-pat <token>', 'PAT shared across all reference repos (for private repos)')
  .action(async (profile: string, task: string, opts: { repo: string[]; repoPat?: string }) => {
    const client = getClient()
    const referenceRepos = opts.repo.length
      ? opts.repo.map(url => ({ url }))
      : undefined

    const session = await withSpinner('Creating research session…', () =>
      client.createSession({
        profileName: profile,
        task,
        outputMode: 'artifact',
        referenceRepos,
        referenceRepoPat: opts.repoPat,
      }),
    )

    console.log(chalk.green(`Research pod ${chalk.bold(session.id)} created.`))
    console.log(`${chalk.bold('Profile:')}  ${session.profileName}`)
    console.log(`${chalk.bold('Status:')}   ${formatStatus(session.status)}`)
    if (session.referenceRepos?.length) {
      console.log(`${chalk.bold('Repos:')}    ${session.referenceRepos.map(r => r.mountPath).join(', ')}`)
    }
    console.log()
    console.log(chalk.dim(`Watch progress:  ap logs ${session.id.slice(0, 8)}`))
    console.log(chalk.dim(`Browse artifacts: open desktop app → session → Markdown tab`))
  })
```

### packages/cli/src/index.ts

Import and register:
```ts
import { registerResearchCommands } from './commands/research.js'
// ...
registerResearchCommands(program, getClient)
```

Find the equivalent registration for `registerWorkspaceCommands` and add next to it.

## Acceptance Criteria

- [ ] `ap research my-profile "research topic"` creates a session with `outputMode: 'artifact'`
- [ ] `ap research my-profile "task" --repo github.com/org/repo` sends `referenceRepos: [{url: "..."}]`
- [ ] `--repo` is repeatable: `--repo url1 --repo url2` → two entries
- [ ] `--repo-pat token` sends `referenceRepoPat`
- [ ] Created session ID and status printed on success
- [ ] Reference repo mount paths shown in output when repos specified
- [ ] `ap research --help` shows correct description and options
- [ ] TypeScript strict mode passes

## Estimated Scope

Files: 2 | Complexity: low
