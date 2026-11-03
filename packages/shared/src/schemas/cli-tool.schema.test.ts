import { describe, expect, it } from 'vitest';
import { cliToolSchema } from './cli-tool.schema.js';
import { toolPackSchema } from './launch-config.schema.js';

const cli = {
  name: 'hindsight',
  description: 'Learn from a fix',
  instructions: 'Use a local fix.',
  verifyArgs: ['--help'],
  source: {
    type: 'github-source',
    repository: 'context-and-sandbox/hindsight',
    commit: 'a'.repeat(40),
    buildCommands: ['npm ci', 'npm run build'],
    executable: 'dist/cli.js',
  },
};

describe('tool-pack CLI schema', () => {
  it('preserves the JSON shape of pre-CLI packs', () => {
    expect(toolPackSchema.parse({})).toEqual({
      instructions: [],
      skills: [],
      mcpServers: [],
      requiredCapabilities: [],
    });
    expect(cliToolSchema.parse(cli)).toMatchObject({
      usage: 'instructed',
      requiredCapabilities: [],
    });
  });
  it('accepts exact npm packages and pinned source recipes', () => {
    expect(cliToolSchema.parse(cli).source.type).toBe('github-source');
    expect(
      cliToolSchema.parse({
        ...cli,
        source: { type: 'npm', package: '@example/tool', version: '1.2.3', executable: 'tool' },
      }).source.type,
    ).toBe('npm');
  });
  it.each(['main', 'v1.0.0', 'a'.repeat(39), `${'a'.repeat(40)};echo nope`])(
    'rejects mutable or malformed source revision %s',
    (commit) => {
      expect(() => cliToolSchema.parse({ ...cli, source: { ...cli.source, commit } })).toThrow();
    },
  );
  it.each(['latest', '^1.2.3', '1.2', '1.2.3;echo nope'])(
    'rejects non-exact package version %s',
    (version) => {
      expect(() =>
        cliToolSchema.parse({
          ...cli,
          source: { type: 'npm', package: 'tool', version, executable: 'tool' },
        }),
      ).toThrow();
    },
  );
  it.each(['../bin/tool', '/bin/tool', 'bin/../../tool', 'bin/$(whoami)', '-tool', 'bin//tool'])(
    'rejects executable path %s',
    (executable) => {
      expect(() =>
        cliToolSchema.parse({ ...cli, source: { ...cli.source, executable } }),
      ).toThrow();
    },
  );
  it('rejects credentials, extra keys, arbitrary URLs and missing offline verification', () => {
    for (const source of [
      { ...cli.source, token: 'secret' },
      { ...cli.source, repository: 'https://token@github.com/org/repo' },
      { type: 'url', url: 'https://example.com/tool' },
    ])
      expect(() => cliToolSchema.parse({ ...cli, source })).toThrow();
    expect(() => cliToolSchema.parse({ ...cli, verifyArgs: [] })).toThrow();
  });
  it('accepts an exact leading ./ archive member while rejecting traversal', () => {
    const source = {
      type: 'github-release',
      repository: 'org/repo',
      tag: 'v1',
      assets: [
        {
          platform: 'linux/amd64',
          asset: 'tool.tar.gz',
          sha256: 'b'.repeat(64),
          format: 'tar.gz',
          executable: './bin/tool',
        },
      ],
    };
    expect(cliToolSchema.parse({ ...cli, source }).source.type).toBe('github-release');
    expect(() =>
      cliToolSchema.parse({
        ...cli,
        source: { ...source, assets: [{ ...source.assets[0], executable: './../tool' }] },
      }),
    ).toThrow();
  });
  it('requires checksums, unique platforms and an explicit archive member', () => {
    const asset = {
      platform: 'linux/amd64',
      asset: 'tool.tar.gz',
      sha256: 'b'.repeat(64),
      format: 'tar.gz',
      executable: 'bin/tool',
    };
    const source = {
      type: 'github-release',
      repository: 'org/repo',
      tag: 'v1.0.0',
      assets: [asset],
    };
    expect(cliToolSchema.parse({ ...cli, source }).source.type).toBe('github-release');
    for (const assets of [
      [{ ...asset, sha256: 'unknown' }],
      [{ ...asset, executable: undefined }],
      [asset, asset],
      [{ ...asset, platform: 'darwin/arm64' }],
      [{ ...asset, asset: '../tool' }],
    ])
      expect(() => cliToolSchema.parse({ ...cli, source: { ...source, assets } })).toThrow();
  });
});
