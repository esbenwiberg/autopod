# Getting started

[README](../README.md) · [CLI reference](reference/cli.md) · [Profile configuration](reference/profiles.md)

Autopod has a daemon that runs the work and clients that connect to it. The
native macOS app, CLI, and phone PWA share the same daemon.

## Connect to an existing daemon

If your daemon is already configured, build the CLI using the next section,
then connect and authenticate:

```bash
ap connect https://your-daemon.example.com
ap login --client-id <application-client-id> --tenant-id <directory-tenant-id>
ap ls
```

Use the tenant/client supplied by the daemon operator. See [Entra setup](reference/operations.md#auth-setup)
for scopes, redirect URIs, and hosted authentication.

## Run a local development daemon

### 1. Install and build

You need **Node.js 22+**, **Git**, **Docker running on the daemon host**, and the
**GitHub CLI** (`gh`) for GitHub-backed repositories. Use `npx pnpm` throughout;
a global pnpm installation is not required. The desktop app additionally needs
macOS 15+ and Xcode.

```bash
git clone https://github.com/esbenwiberg/autopod.git
cd autopod
npx pnpm install
npx pnpm build
```

Make the built CLI available as `ap` in this shell, without a global install:

```bash
AUTOPOD_REPO="$PWD"
ap() { node "$AUTOPOD_REPO/packages/cli/dist/index.js" "$@"; }
ap --help
```

Define the helper again in any new shell, setting `AUTOPOD_REPO` to your checkout.
All remaining commands assume you are at the repository root.

### 2. Configure local-only development

```bash
cp .env.example .env
```

Edit these values in `.env` (do not commit it):

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3100
ENTRA_CLIENT_ID=placeholder
ENTRA_TENANT_ID=placeholder
AUTOPOD_ALLOW_DEV_AUTH=1
ANTHROPIC_API_KEY=<your-api-key>
```

These settings are for a **local development daemon**, not an internet-facing
service. Dev-token authentication requires the explicit opt-in above; the CLI
uses the local daemon's token automatically when both run under the same user.
Do not expose this configuration publicly. For a remote daemon, configure
[Entra authentication](reference/operations.md#auth-setup) and
[hosted TLS](hosted-daemon-tls-entra.md) instead.

The API key above selects the simplest Claude setup. Other supported credentials
include [OpenAI, Claude subscription OAuth, Foundry, and Copilot](reference/profiles.md#multi-provider-model-auth).
Provider availability, subscriptions, and model access depend on your account.

### 3. Authenticate the daemon's GitHub identity

Run this as the same OS user that will run the daemon:

```bash
gh auth login --hostname github.com --git-protocol https
```

Use a dedicated, lower-privilege account with access only to the repositories it
needs. Profile `githubPat` fields are legacy compatibility fields, not the active
GitHub identity. If you run the daemon in Docker instead, authenticate **inside
that container**; see [daemon GitHub identity](reference/profiles.md#daemon-github-identity).

### 4. Start the daemon

The loopback-only settings above are intended for Docker Desktop on macOS.
Workers must also be able to reach the daemon for MCP callbacks, not just the
host CLI. By default they use `http://host.docker.internal:3100`.

**Native Linux Docker:** a loopback-only listener is not reachable through the
Docker host gateway. Before starting tasks, configure the host firewall to allow
TCP 3100 only from loopback and your actual worker Docker network subnets, denying
LAN/WAN access. Then change `HOST` to `0.0.0.0` in `.env` so the gateway can reach
it; keep the local CLI connected to `http://localhost:3100`. Alternatively use a
Docker-facing proxy restricted to those subnets that forwards to the loopback
listener. Set `AUTOPOD_MCP_BASE_URL` if that proxy uses a different address/port.
Do **not** change the bind address without the firewall/proxy restrictions, and
do not expose development authentication publicly. A successful host health check
alone does not prove container-to-daemon connectivity.

From the repository root:

```bash
node --env-file=.env packages/daemon/dist/index.js
```

This loads the root `.env` explicitly. Leave the daemon running. In a second
shell, define the `ap` helper from step 1, then:

```bash
ap connect http://localhost:3100
ap health
```

Don't use the placeholder Entra IDs with `ap login`; local dev-token auth is a
separate path. [Production authentication](reference/operations.md#auth-setup)
uses real Entra IDs and `ap login`.

### 5. Configure a repository

```bash
ap profile create
```

This opens `$EDITOR` with a YAML template. Set it to your repository and its real
build, test, and start commands. For example, a small npm/Vite web app:

```yaml
name: my-app
repoUrl: https://github.com/owner/my-app.git
defaultBranch: main
template: node24-pw
modelProvider: anthropic
defaultRuntime: claude
defaultModel: claude-opus-5-5
reviewerModel: claude-sonnet-5-5
buildCommand: npm ci && npm run build
testCommand: npm test
startCommand: npm run preview -- --host 0.0.0.0 --port $PORT
healthPath: /
smokePages:
  - path: /
maxValidationAttempts: 3
```

This is an example, not a universal build recipe. Choose model IDs available to
your provider. Browser checks require an appropriate image (such as `node24-pw`)
and a working start command. For non-web projects, configure `hasWebUi: false`
and the relevant deterministic checks instead.

See [profile configuration](reference/profiles.md) for inheritance, network
policy, provider credentials, private feeds, and validation settings;
[Node worker images](node24-environments.md) covers image preparation.

### 6. Delegate, inspect, decide

```bash
ap run my-app "Add a dark mode toggle to the settings page"
ap ls
ap status <pod-id>
ap logs <pod-id>
ap diff <pod-id>
```

After the configured checks finish, inspect the evidence and readiness before
deciding:

```bash
ap approve <pod-id>
# Or send feedback for another attempt:
ap reject <pod-id> "The selected theme should survive a page refresh"
```

Approval and merge still follow the pod's configured output and delivery policy.
A check passing is not proof that the change has been published or merged.
[Readiness Review](reference/validation.md#validation-pipeline) explains approval
guards, risk acknowledgments, retries, and advisory browser QA.

## Use the macOS app

Build and install from this checkout:

```bash
./scripts/install-desktop.sh
```

This installs to `/Applications/Autopod.app`, replacing an existing local copy.
Launch it and connect to the same daemon. To try the interface without connecting
a daemon or provider, build the separate offline fixture preview instead:

```bash
./scripts/build-desktop-preview.sh --fixtures
open "packages/desktop/build-preview/Build/Products/Debug/Autopod Preview.app"
```

The preview uses sample data and does not execute real tasks. It does not replace
the installed production app.

## Use your phone

The [mobile setup guide](mobile.md) covers Tailscale Serve, pairing, the PWA, and
remote approve/reject/nudge actions. Don't publish an unprotected development
daemon to the internet.
