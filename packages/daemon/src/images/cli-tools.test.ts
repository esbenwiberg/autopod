import {
  type CliTool,
  cliToolSchema,
  environmentPresetSchema,
  toolPackSchema,
} from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  cliToolInstallCommands,
  cliToolInstructions,
  frozenCliTools,
  selectCliTools,
} from './cli-tools.js';
import { generateEnvironmentDockerfile } from './environment-dockerfile.js';
import { environmentImageKey } from './environment-image-key.js';

const environment = environmentPresetSchema.parse({
  template: 'node22',
  capabilities: ['node'],
  prepareCommands: ['echo prepare'],
});
const cli = cliToolSchema.parse({
  name: 'lesson',
  description: 'Learn from fixes',
  instructions: 'lesson --help',
  usage: 'discretionary',
  requiredCapabilities: ['node'],
  verifyArgs: ['--help'],
  source: { type: 'npm', package: '@example/lesson', version: '1.2.3', executable: 'lesson' },
});
const pack = (clis: CliTool[]) => toolPackSchema.parse({ clis });
const input = {
  environment,
  pinnedBase: `sha256:${'a'.repeat(64)}`,
  platform: 'linux/amd64' as const,
  agentToolingDigest: 'b'.repeat(64),
  toolInstallCommands: ['echo software'],
};

describe('CLI selection and installation', () => {
  it('deduplicates identical CLI definitions and sorts them for stable images', () => {
    const other = { ...cli, name: 'another' };
    expect(selectCliTools([pack([cli]), pack([other, cli])], environment)).toEqual([other, cli]);
  });
  it('rejects conflicting definitions, unavailable capabilities and foundational names before build', () => {
    expect(() =>
      selectCliTools([pack([cli]), pack([{ ...cli, instructions: 'Different' }])], environment),
    ).toThrow('Conflicting CLI');
    expect(() =>
      selectCliTools([pack([{ ...cli, requiredCapabilities: ['python'] }])], environment),
    ).toThrow('requires environment capability python');
    expect(() =>
      selectCliTools([toolPackSchema.parse({ requiredCapabilities: ['python'] })], environment),
    ).toThrow('requires environment capability python');
    for (const name of ['git', 'node', 'CLAUDE', 'timeout'])
      expect(() => selectCliTools([pack([{ ...cli, name }])], environment)).toThrow('conflicts');
    expect(() =>
      selectCliTools([pack([cli])], {
        ...environment,
        tools: [{ name: 'npm:lesson', version: '1.2.3' }],
      }),
    ).toThrow('conflicts');
  });
  it('installs npm packages in a private prefix without changing the environment toolchain', () => {
    const command = cliToolInstallCommands([cli], 'linux/amd64').join('\n');
    expect(command).toContain("'@example/lesson@1.2.3'");
    expect(command).toContain('--registry https://registry.npmjs.org');
    expect(command).toContain("test ! -L '/home/autopod/.local/bin/lesson'");
    expect(command).toContain("timeout 30 '/home/autopod/.local/bin/lesson' '--help'");
    expect(command).not.toContain('--global');
    expect(command).not.toContain('|| true');
  });
  it('checks out the exact public GitHub commit and quotes trusted build recipes and probe arguments', () => {
    const sourceCli = cliToolSchema.parse({
      ...cli,
      verifyArgs: ["it's literal; $(echo nope)"],
      source: {
        type: 'github-source',
        repository: 'org/tool',
        commit: 'c'.repeat(40),
        buildCommands: ["printf '%s' hello", 'npm ci && npm run build'],
        executable: 'dist/cli.js',
      },
    });
    const command = cliToolInstallCommands([sourceCli], 'linux/amd64')[0] ?? '';
    expect(command).toContain('GIT_TERMINAL_PROMPT=0');
    expect(command).toContain('credential.helper=');
    expect(command).toContain(`https://github.com/org/tool.git' '${'c'.repeat(40)}'`);
    expect(command).toContain('rev-parse HEAD');
    expect(command).toContain("timeout 600 sh -e -c 'npm ci && npm run build'");
    expect(command).toContain("'it'\\''s literal; $(echo nope)'");
  });
  it('verifies a selected release checksum before extracting only the executable to stdout', () => {
    const release = cliToolSchema.parse({
      ...cli,
      source: {
        type: 'github-release',
        repository: 'org/tool',
        tag: 'v1.0.0',
        assets: [
          {
            platform: 'linux/amd64',
            asset: 'tool.tar.gz',
            sha256: 'd'.repeat(64),
            format: 'tar.gz',
            executable: 'bin/tool',
          },
        ],
      },
    });
    const command = cliToolInstallCommands([release], 'linux/amd64')[0] ?? '';
    expect(command).toContain('https://github.com/org/tool/releases/download/v1.0.0/tool.tar.gz');
    expect(command.indexOf('sha256sum --check')).toBeLessThan(command.indexOf('tar -xzOf'));
    expect(command).toContain("--proto '=https' --proto-redir '=https'");
    expect(command).toContain("-- 'bin/tool' >");
    expect(() => cliToolInstallCommands([release], 'linux/arm64')).toThrow(
      'no release asset for linux/arm64',
    );
  });
  it('changes image identity for software/probes but not usage guidance', () => {
    const key = (tools: CliTool[]) =>
      environmentImageKey({
        ...input,
        cliInstallCommands: cliToolInstallCommands(tools, input.platform),
      });
    expect(key([cli])).not.toBe(key([]));
    expect(key([cli])).toBe(key([{ ...cli, instructions: 'Different', usage: 'instructed' }]));
    expect(key([cli])).not.toBe(key([{ ...cli, verifyArgs: ['--version'] }]));
    expect(key([cli])).not.toBe(
      key([
        {
          ...cli,
          source: {
            type: 'npm',
            package: '@example/lesson',
            version: '1.2.4',
            executable: 'lesson',
          },
        },
      ]),
    );
    expect(environmentImageKey(input)).toBe(
      environmentImageKey({ ...input, cliInstallCommands: [] }),
    );
  });
  it('installs and probes CLIs after environment preparation as the worker user', () => {
    const dockerfile = generateEnvironmentDockerfile({
      ...input,
      cliInstallCommands: cliToolInstallCommands([cli], input.platform),
    });
    expect(dockerfile).toContain('USER autopod');
    expect(dockerfile.indexOf('echo software')).toBeLessThan(dockerfile.indexOf('echo prepare'));
    expect(dockerfile.indexOf('echo prepare')).toBeLessThan(dockerfile.indexOf('npm install'));
    expect(dockerfile).not.toContain('COPY');
  });
  it('renders frozen CLI definitions without reapplying current admission policy', () => {
    const historical = { ...cli, name: 'node', requiredCapabilities: ['retired-capability'] };
    expect(() => selectCliTools([pack([historical])], environment)).toThrow();
    const replay = frozenCliTools([pack([historical]), pack([historical])]);
    expect(replay).toEqual([historical]);
    expect(cliToolInstructions(replay)).toContain('### node');
  });
  it('explains instructed/discretionary use without granting access or claiming live readiness', () => {
    const guidance = cliToolInstructions([cli, { ...cli, name: 'manual', usage: 'instructed' }]);
    expect(guidance).toContain('You may choose this tool');
    expect(guidance).toContain('only when the task or human explicitly requests it');
    expect(guidance).toContain('no extra credentials');
    expect(guidance).toContain('does not prove external authentication');
    expect(guidance).toContain(cli.instructions);
    expect(cliToolInstructions([])).toBe('');
  });
});
