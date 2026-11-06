<p align="center">
  <img src="assets/icon.png" alt="" width="80">
</p>

<h1 align="center">Autopod</h1>

<p align="center">
  <strong>Delegate the work. Review the evidence.</strong><br>
  Run coding agents in isolated containers, validate their changes, and stay in control of what ships.
</p>

<p align="center">
  <a href="#why-autopod">Why Autopod</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#see-it-in-action">See it in action</a> ·
  <a href="#getting-started">Get started</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="https://esbenwiberg.github.io/autopod">Explore the docs ↗</a>
</p>

[![Autopod's native macOS app showing a fleet of agent pods across repositories, with task progress and validation details. Offline sample data.](assets/readme/desktop.png)](assets/readme/desktop.png)

<p align="center">
  <sub>macOS desktop preview · real UI, offline sample data · click to enlarge</sub>
</p>

## Why Autopod

Starting an agent is easy. Turning its output into a change you can confidently
review is the real work.

Autopod connects the parts around the agent—isolated environments, parallel work,
independent checks, and feedback loops—so **you're not the glue holding every
task together.**

[![Why Autopod: parallel agents, independent validation, feedback loops, model and infrastructure choice, repeatable workflows, and human control. How it works: describe, run an isolated agent, verify, decide, and deliver under your configured policy.](assets/readme/features.png)](assets/readme/features.png)

- **More work in flight, less context-switching.** Run independent tasks across
  repositories, each with its own container and branch. One fleet view, not a
  terminal for every agent.
- **Proof beyond “done.”** Review configured build/test results, diffs, required
  evidence, and a separate AI task review. Add browser checks for web projects.
- **Another attempt, not another manual restart.** Failed required checks feed
  structured feedback back to the agent, within your configured retry limits.
- **Your models. Your stack.** Choose Claude, Codex, or Copilot; local Docker or
  Azure Container Apps Sandboxes; GitHub or Azure DevOps PRs.
- **Workflows, not just one-off prompts.** Chain dependent pods into a series,
  schedule recurring work, and reuse repository profiles and prompt templates.
- **Your attention where it matters.** Answer escalations, pause or nudge work,
  inspect readiness, and approve or reject from your phone when you're away.

<details>
<summary><strong>And the details that make it practical</strong></summary>

- **Set up a repo once:** inheritable profiles, warmed images, and private package feeds.
- **Carry lessons forward:** human-approved, scoped memory with source evidence and usage history.
- **Bring your context:** inject MCP tools, skills, and repository instructions into pods.
- **Set deliberate boundaries:** per-profile network policies and control-plane action approvals.
- **See where the spend goes:** per-pod cost breakdowns and fleet analytics by phase and model.

[Explore profiles and integrations →](docs/reference/profiles.md) ·
[Explore workflows →](docs/reference/cli.md#series) ·
[Explore analytics →](docs/reference/operations.md#analytics)

</details>

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

Start with an outcome, not a terminal session. Autopod coordinates the work and
the checks, then brings the evidence back to you.

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
