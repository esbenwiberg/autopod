# CLI tools in tool packs

Tool packs can declare `clis` alongside skills, MCP servers and instructions. Selecting the pack installs and probes its CLI software while building the worker image, then supplies usage guidance to the agent. No second environment edit is required. This is source functionality; it does not change hosted configuration, enable composable admission, or establish live backend acceptance.

Environments still own the foundation: operating-system packages, Node/Python/.NET, sidecars and capabilities. CLI recipes are trusted operator-authored software, not agent-selected arbitrary installations. They run as `autopod` in a software-only Docker build with no application checkout or credential build arguments.

## Configure

In the desktop configuration library, open a **Tool pack → Software → CLI tools**. Add the command, purpose, usage instructions, offline verification arguments, prerequisite capabilities and pinned installation source. Full JSON works through the existing preset editor/CLI as well. Select the pack in a profile or per launch with `--tool-pack <id>`.

An example tool-pack payload (replace the illustrative npm package with a real package):

```json
{
  "clis": [{
    "name": "lesson",
    "description": "Inspect a bug fix for reusable prevention opportunities.",
    "instructions": "Run lesson --help for syntax. Use local issue text and locally available fix commits. Resulting edits must pass the task's normal validation and review.",
    "usage": "instructed",
    "requiredCapabilities": ["node"],
    "verifyArgs": ["--help"],
    "source": {
      "type": "npm",
      "package": "@example/lesson",
      "version": "1.2.3",
      "executable": "lesson"
    }
  }]
}
```

- `name` is the command exposed on PATH; `source.executable` selects the installed executable.
- `usage: "instructed"` tells the agent to use it only when explicitly requested. `"discretionary"` permits the agent to choose when useful within the task's existing permissions. **This is prompt guidance, not a sandbox permission control.**
- `requiredCapabilities` must be declared by the environment. Capability labels are operator assertions, not automatic version detection; use a suitable foundation and a meaningful verification probe.
- `verifyArgs` is an argument array, not shell syntax. Choose an offline, non-mutating probe such as `--help` or `--version` that needs no provider credentials. It must exit successfully within 30 seconds. A successful probe does not establish external authentication or live service readiness.
- Identical definitions across selected packs deduplicate. Different definitions with the same command conflict. Foundation/runtime names are reserved; known environment package-name collisions fail during preview. Actual pre-existing PATH executable collisions fail during image building rather than being overwritten.

CLI commands are placed under `/home/autopod/.local/bin`, with per-tool software under `/home/autopod/.local/share/autopod-clis/<name>`. The unprivileged agent shim restores that PATH entry even when a sandbox Goal supervisor starts with a minimal system PATH; the privileged supervisor's PATH stays unchanged. Installation follows environment package installation and preparation. CLI source identity, recipe and verification arguments affect the software image key. Description, guidance and usage policy affect the frozen launch digest but do not rebuild identical software. Old packs without `clis` retain their JSON shape and old software-image identity.

## Supported public sources

### Exact npm package

`source: { "type": "npm", "package": "@org/package", "version": "1.2.3", "executable": "command" }`

The package installs from `registry.npmjs.org` into an isolated per-tool prefix, not globally over the environment's toolchain. Only an exact version is accepted; tags/ranges/Git URLs are rejected. This pins the direct package, not every transitive dependency: use a locked source recipe or checksum-verified release when stronger reproducibility is needed. Package lifecycle scripts execute as trusted software.

### Pinned GitHub source

```json
{
  "type": "github-source",
  "repository": "owner/repository",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "buildCommands": ["npm ci --no-audit --no-fund", "npm run build"],
  "executable": "dist/cli.js"
}
```

Use the GitHub `owner/repository` identity from its URL and a full 40-character commit SHA, not `main`, a branch, an abbreviation or a mutable tag. The public source is fetched non-interactively, checked out at that exact commit, and built using the supplied commands. Each recipe command has a ten-minute timeout. Dependencies may still access package registries; pin/lock those through the recipe's normal build tooling. The selected executable must be a runnable binary or have a valid shebang. **Public repositories only:** no operator/daemon GitHub credentials are available to image builds.

### Checksum-verified GitHub release

```json
{
  "type": "github-release",
  "repository": "owner/repository",
  "tag": "v1.2.3",
  "assets": [{
    "platform": "linux/amd64",
    "asset": "tool-linux-amd64.tar.gz",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "format": "tar.gz",
    "executable": "bin/tool"
  }]
}
```

Provide an asset for the resolved Linux platform (`linux/amd64` or `linux/arm64`). Missing platforms reject preview. Downloads are HTTPS-only, and checksum verification precedes extraction/execution. For `tar.gz`, only the named member is streamed to a fixed executable file; archive paths are not extracted into the filesystem. Match the member name from `tar -tzf` exactly, including an optional leading `./`. For a raw executable use `format: "binary"` and omit `executable`. Assets that need adjacent libraries/resources, zip archives and arbitrary download hosts are not supported in this slice. Supply trusted checksums independently; a release tag alone is not immutable.

No secrets, authenticated URLs or credential references are accepted in source definitions. Do not put secrets into trusted recipe command strings either; those strings are retained in configuration, Docker build history and image identity. These definitions do not resolve friendly refs/URLs automatically yet; enter the explicit repository/commit or release/checksum fields.

## Local verification

Focused tests live in `packages/shared/src/schemas/cli-tool.schema.test.ts`,
`packages/daemon/src/images/cli-tools.test.ts` and
`packages/daemon/src/configuration/cli-tools.test.ts`. Desktop form/layout fixtures
cover npm, source and release definitions without connecting to a daemon.

An opt-in Docker fixture builds/probes as the real worker user, installs a public
npm package (`cowsay@1.6.0`), exercises real Git checkout/checksum/tar commands with
fixture-controlled GitHub transport, and rejects checksum/probe failures:

```sh
AUTOPOD_CLI_TOOL_FIXTURE_IMAGE="$(docker image inspect autopod-node22:latest --format '{{.Id}}')" \
  npx pnpm --filter @autopod/daemon exec vitest run src/images/cli-tools.docker.test.ts
```

The selected local image must provide user `autopod`, Node/npm, Git, curl, tar and
coreutils. The fixture creates and removes only its own temporary image tags and
container. Image building needs public npm access; executable checks run with
container networking disabled. These fixtures do not establish real GitHub download,
private-source, provider authentication, nested-agent or hosted sandbox acceptance.

## Hindsight

The inspected local Hindsight checkout points to **`context-and-sandbox/hindsight`**, not `esbenwiberg/hindsight`. At inspection its main commit was `fb159c616288403a3ff366b2239f5f075b62eaac`, and GitHub reported the repository as **private**. It is an unpublished npm package requiring Node >=22.12.0. Consequently neither the public npm nor public GitHub source installer can currently provision that repository. No Hindsight pack is automatically enrolled or enabled by this change.

If an approved public source becomes available, its recipe shape is:

- Source executable: `dist/cli.js`.
- Build commands: `npm ci --no-audit --no-fund`, then `npm run build`.
- Offline probe: `["--help"]`.
- Start with `usage: "instructed"`; document `hindsight --issue "..." --fix HEAD --agent codex` (or explicitly selected Claude) against the task's local repository.
- Prefer issue text and locally available fix commits/ranges. GitHub issue/PR URL inputs require authenticated `gh`, which the pack does not grant.
- Hindsight launches another Codex/Claude process and may apply prevention edits. Before enabling actual investigations, verify supported CLI versions, nested authentication and permission behavior, cancellation/child-process cleanup, and model usage/budget accounting on each intended backend. Do not recursively launch Hindsight from its own investigation.
- Hindsight's validation is agent-reported. After prevention edits, normal Autopod validation and independent review are still required.

Private-source materialization must be designed separately: authenticate outside the image, authorize the exact repository/revision, transfer only source or a verified build artifact, and ensure credentials never reach image layers or the worker. Merely adding a token to a clone URL/build argument is not an acceptable implementation.
