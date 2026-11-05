import {
  type CliTool,
  cliToolSchema,
  type EnvironmentPreset,
  type ToolPack,
} from '@autopod/shared';
import { configurationDigest } from '../configuration/configuration-digest.js';
import { configurationError } from '../configuration/configuration-store.js';

const reserved = new Set([
  'ap',
  'autopod',
  'bash',
  'bun',
  'cat',
  'chmod',
  'chown',
  'claude',
  'codex',
  'copilot',
  'cp',
  'curl',
  'dotnet',
  'env',
  'git',
  'ln',
  'mkdir',
  'mv',
  'node',
  'npm',
  'npx',
  'pi',
  'pip',
  'pip3',
  'pnpm',
  'python',
  'python3',
  'rm',
  'sh',
  'sha256sum',
  'tar',
  'timeout',
  'uv',
  'uvx',
  'yarn',
]);
const binDirectory = '/home/autopod/.local/bin';
const toolDirectory = '/home/autopod/.local/share/autopod-clis';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Fail before image discovery/build; ordering does not change the software identity. */
export function selectCliTools(packs: ToolPack[], environment: EnvironmentPreset): CliTool[] {
  const tools = new Map<string, CliTool>();
  const environmentNames = new Set(
    environment.tools.map(({ name }) =>
      name
        .replace(/^(npm|pip|dotnet):/, '')
        .split('/')
        .at(-1),
    ),
  );
  for (const pack of packs) {
    for (const capability of pack.requiredCapabilities) {
      if (!environment.capabilities.includes(capability))
        configurationError(
          `Tool pack requires environment capability ${capability}`,
          'TOOL_CAPABILITY_MISSING',
        );
    }
    for (const raw of pack.clis ?? []) {
      const cli = cliToolSchema.parse(raw);
      if (reserved.has(cli.name.toLowerCase()) || environmentNames.has(cli.name))
        configurationError(
          `CLI name ${cli.name} conflicts with worker/environment software`,
          'TOOL_NAME_RESERVED',
        );
      for (const capability of cli.requiredCapabilities) {
        if (!environment.capabilities.includes(capability))
          configurationError(
            `CLI ${cli.name} requires environment capability ${capability}`,
            'TOOL_CAPABILITY_MISSING',
          );
      }
      const previous = tools.get(cli.name);
      if (previous && configurationDigest(previous) !== configurationDigest(cli))
        configurationError(`Conflicting CLI ${cli.name} in selected tool packs`, 'TOOL_CONFLICT');
      tools.set(cli.name, cli);
    }
  }
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** Public software only, executed as the worker user in a software-only image build. */
export function cliToolInstallCommands(
  tools: CliTool[],
  platform: 'linux/amd64' | 'linux/arm64',
): string[] {
  return tools.map((raw) => {
    const cli = cliToolSchema.parse(raw);
    const root = `${toolDirectory}/${cli.name}`;
    const binary = `${binDirectory}/${cli.name}`;
    const source = cli.source;
    const commands = [
      `mkdir -p ${quote(binDirectory)} ${quote(toolDirectory)}`,
      // Never replace an executable supplied by the foundation, including system PATH entries.
      `if command -v ${quote(cli.name)} >/dev/null 2>&1; then echo ${quote(`CLI ${cli.name} already exists on PATH`)} >&2; exit 1; fi`,
      `test ! -e ${quote(binary)} && test ! -L ${quote(binary)}`,
      `mkdir ${quote(root)}`,
    ];
    if (source.type === 'npm') {
      commands.push(
        `timeout 600 npm install --prefix ${quote(root)} --registry https://registry.npmjs.org --omit=dev --no-audit --no-fund ${quote(`${source.package}@${source.version}`)}`,
        `test -x ${quote(`${root}/node_modules/.bin/${source.executable}`)}`,
        `ln -s ${quote(`${root}/node_modules/.bin/${source.executable}`)} ${quote(binary)}`,
      );
    } else if (source.type === 'github-source') {
      const checkout = `${root}/source`;
      commands.push(
        `git init ${quote(checkout)}`,
        `GIT_TERMINAL_PROMPT=0 timeout 120 git -c credential.helper= -c http.extraHeader= -C ${quote(checkout)} fetch --depth=1 ${quote(`https://github.com/${source.repository}.git`)} ${quote(source.commit)}`,
        `git -C ${quote(checkout)} checkout --detach ${quote(source.commit)}`,
        `test "$(git -C ${quote(checkout)} rev-parse HEAD)" = ${quote(source.commit)}`,
        ...source.buildCommands.map(
          (command) => `(cd ${quote(checkout)} && timeout 600 sh -e -c ${quote(command)})`,
        ),
        `test -f ${quote(`${checkout}/${source.executable}`)}`,
        `chmod u+x ${quote(`${checkout}/${source.executable}`)}`,
        `ln -s ${quote(`${checkout}/${source.executable}`)} ${quote(binary)}`,
      );
    } else {
      const asset = source.assets.find((asset) => asset.platform === platform);
      if (!asset)
        configurationError(
          `CLI ${cli.name} has no release asset for ${platform}`,
          'CLI_PLATFORM_UNSUPPORTED',
        );
      const download = `${root}/download`;
      const executable = `${root}/executable`;
      const url = `https://github.com/${source.repository}/releases/download/${encodeURIComponent(source.tag)}/${encodeURIComponent(asset.asset)}`;
      commands.push(
        `timeout 120 curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 120 --output ${quote(download)} ${quote(url)}`,
        `printf '%s  %s\\n' ${quote(asset.sha256)} ${quote(download)} | sha256sum --check --status`,
        asset.format === 'binary'
          ? `mv ${quote(download)} ${quote(executable)}`
          : // Extract only one member to stdout, never archive paths/symlinks into the image.
            `tar -xzOf ${quote(download)} -- ${quote(asset.executable ?? '')} > ${quote(executable)} && rm ${quote(download)}`,
        `test -s ${quote(executable)} && chmod u+x ${quote(executable)}`,
        `ln -s ${quote(executable)} ${quote(binary)}`,
      );
    }
    commands.push(`timeout 30 ${quote(binary)} ${cli.verifyArgs.map(quote).join(' ')} >/dev/null`);
    return commands.join(' && ');
  });
}

/** Replay already-admitted definitions without applying today's admission policy to frozen work. */
export function frozenCliTools(packs: ToolPack[]): CliTool[] {
  const tools = new Map<string, CliTool>();
  for (const pack of packs) for (const cli of pack.clis ?? []) tools.set(cli.name, cli);
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** Prompt policy is guidance, not an OS permission boundary. */
export function cliToolInstructions(tools: CliTool[]): string {
  if (!tools.length) return '';
  return [
    '## Available CLI tools',
    'These selected CLIs are installed on PATH and passed their offline image-build probes. This does not prove external authentication or live service availability.',
    'Do not install or upgrade these tools yourself. Tool selection grants no extra credentials, network access, publication authority or permission to bypass checks. All resulting edits remain subject to normal validation and review.',
    ...tools.map((cli) =>
      [
        `### ${cli.name}`,
        cli.description,
        cli.usage === 'discretionary'
          ? 'You may choose this tool when useful to the task, within existing permissions.'
          : 'Use this tool only when the task or human explicitly requests it.',
        cli.instructions,
      ].join('\n\n'),
    ),
  ].join('\n\n');
}
