<p align="center">
  <img src="assets/icon.png" alt="" width="80">
</p>

<h1 align="center">Autopod</h1>

<p align="center">
  <strong>Delegate the work. Review the evidence.</strong><br>
  Run coding agents in isolated containers, validate their changes, and stay in control of what ships.
</p>

<p align="center">
  <a href="#getting-started">Get started</a> ·
  <a href="#see-it-in-action">See it in action</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="https://esbenwiberg.github.io/autopod">Explore the docs ↗</a>
</p>

[![Autopod's native macOS app showing a fleet of agent pods across repositories, with task progress and validation details. Offline sample data.](assets/readme/desktop.png)](assets/readme/desktop.png)

<p align="center">
  <sub>macOS desktop preview · real UI, offline sample data · click to enlarge</sub>
</p>

## More agents. Less babysitting.

A coding agent can write a patch. Getting that patch safely from a task to a
reviewable result is the rest of the job.

Autopod handles the environment, parallel execution, configured checks, and
feedback loops. You get a workspace for the decisions that matter: what is
running, what needs help, what changed, and whether the evidence supports shipping.

| | What you get |
| :-- | :-- |
| **A fleet, not a pile of terminals** | Run tasks across repositories. See progress, costs, blockers, and work that needs your attention. |
| **Evidence beyond “done”** | Inspect build/test results, diffs, required proof, and a separate AI task review. Add browser checks for web projects. |
| **Control at the right moments** | Answer escalations, pause or nudge an agent, request changes, and review readiness before approval. |
| **Your tools, your environment** | Claude, Codex, or Copilot runtimes. Local Docker or Azure Container Apps Sandboxes. GitHub or Azure DevOps PRs. |

## See it in action

![A captioned tour of the actual desktop UI: fleet overview, reported work, readiness findings, and the code diff. Offline fixtures, not a live execution.](assets/readme/tour.gif)

<p align="center">
  <sub>The redesigned desktop, enabled in Appearance settings. Offline sample data—not a live agent run.<br>
  Prefer a still? <a href="assets/readme/desktop.png">Open the workspace screenshot</a>.</sub>
</p>

### Review the evidence, not just the status

A task can be validated and still deserve a closer look. Readiness brings
validation, security, scope, quality, network events, and PR state together so
that a green check doesn't have to tell the whole story.

[![Readiness Review in the native app, showing a compatibility warning and the evidence areas that need operator review. Offline sample data.](assets/readme/readiness.png)](assets/readme/readiness.png)

<p align="center">
  <sub>Sample readiness findings are deliberately visible—not a fabricated all-green run.</sub>
</p>

## How it works

```text
Describe a task → Isolated agent → Configured checks → Review & decide → Delivery
                       ↑                  │
                       └─── feedback ─────┘
```

1. **Describe the outcome.** Select a repository configuration and task. For
   larger changes, use specs with executable proof and dependent pod workflows.
2. **Let the agent work.** Each pod gets its own container and branch. Agents can
   report progress and ask for help; you can pause or send instructions.
3. **Check the result independently.** Run the configured lint, security, build,
   test, acceptance, and required-fact checks, plus a separate AI task review.
   Web projects can capture browser evidence. Optional advisory browser QA adds
   context; it isn't a blocking validation gate.
4. **Decide what ships.** Inspect the diff, evidence, and readiness. Approve or
   request changes—or configure auto-approval within the readiness and delivery
   guards. Delivery follows the selected output and PR policy.

Validation is configurable, not a promise that every task runs every check.
A passing review is not approval, publication, or proof of a merge.
[Read about validation and readiness →](docs/reference/validation.md)

## Getting started

Autopod is self-hosted. The daemon runs the work; the macOS app, CLI, and phone
PWA connect to it. You can run workers locally with Docker or configure Azure
Container Apps Sandboxes.

**For local development:** Node.js 22+, Git, Docker, and GitHub CLI for
GitHub-backed repositories. The desktop app additionally needs macOS 15+ and
Xcode. Hosted sign-in uses Azure Entra ID.

```bash
git clone https://github.com/esbenwiberg/autopod.git
cd autopod
npx pnpm install
npx pnpm build
```

**[Follow the setup guide →](docs/getting-started.md)** It covers daemon settings,
provider authentication, the `ap` CLI, and your first repository configuration.
Already have a daemon? [Connect to it instead](docs/getting-started.md#connect-to-an-existing-daemon).

Once configured, the basic CLI workflow is:

```bash
ap run my-app "Add a dark mode toggle to the settings page"
ap ls
ap status <pod-id>
ap diff <pod-id>
ap approve <pod-id>
# Want another iteration instead?
ap reject <pod-id> "The selected theme should survive a page refresh"
```

## One daemon. Three ways to stay in control.

- **macOS app** — browse the fleet, inspect diffs and evidence, manage repository
  configuration, and work in a live terminal. [Build the app →](docs/getting-started.md#use-the-macos-app)
- **CLI** — launch tasks, follow activity, and script your workflows.
  [Command reference →](docs/reference/cli.md)
- **Phone PWA** — answer escalations and approve, reject, kill, or nudge work
  through a Tailscale-served inbox. [Pair your phone →](docs/mobile.md)

## Documentation

| Start here | Go deeper |
| :-- | :-- |
| [Setup & first task](docs/getting-started.md) | [CLI & dependent pod workflows](docs/reference/cli.md) |
| [Repository profiles & providers](docs/reference/profiles.md) | [Validation, evidence & readiness](docs/reference/validation.md) |
| [Mobile access](docs/mobile.md) | [Authentication, deployment & operations](docs/reference/operations.md) |
| [Architecture](ARCHITECTURE.md) | [Azure Container Apps Sandboxes](docs/azure-container-apps-sandboxes.md) |
| [Contributing](CONTRIBUTING.md) | [Security model](docs/threat-model.md) |

## Development

```bash
npx pnpm lint
npx pnpm build
npx pnpm test
```

The daemon and CLI are TypeScript; the macOS app is SwiftUI/AppKit. See
[the development reference](docs/reference/operations.md#development) for package
layout and checks, and [the desktop test guide](docs/desktop/test-isolation.md)
for native tests.

## License

MIT

---

<p align="center">
  <sub>Spec in. Evidence out. You decide what ships.</sub>
</p>
