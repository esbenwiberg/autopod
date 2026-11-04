import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliToolSchema } from '@autopod/shared';
import { expect, it } from 'vitest';
import { AGENT_SHIM_SCRIPT } from '../pods/provisioning-runtime-files.js';
import { cliToolInstallCommands } from './cli-tools.js';

// Opt-in, local Docker only. Real npm transport; Git/release transport is fixture-controlled.
const image = process.env.AUTOPOD_CLI_TOOL_FIXTURE_IMAGE;
it.skipIf(!image)(
  'builds and probes CLI tools as the worker user; checksum and probe failures block installation',
  () => {
    if (!image || !/^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(image))
      throw new Error(
        'AUTOPOD_CLI_TOOL_FIXTURE_IMAGE must be an immutable local Linux image with user autopod, Node/npm, Git, curl, tar and coreutils',
      );
    const context = mkdtempSync(join(tmpdir(), 'autopod-cli-tools-'));
    const suffix = `${process.pid}-${Date.now()}`;
    const tag = `autopod-cli-tools-fixture:${suffix}`;
    const baseTag = `autopod-cli-tools-fixture-base:${suffix}`;
    const container = `autopod-cli-tools-fixture-${suffix}`;
    const docker = (args: string[]) =>
      execFileSync('docker', args, {
        encoding: 'utf8',
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    try {
      // BuildKit treats bare sha256 IDs as registry names. Bind the selected local image to an
      // owned temporary tag rather than pulling an unrelated repository called "sha256".
      docker(['image', 'tag', image, baseTag]);
      expect(docker(['image', 'inspect', baseTag, '--format', '{{.Id}}'])).toBe(
        docker(['image', 'inspect', image, '--format', '{{.Id}}']),
      );
      const source = join(context, 'source');
      mkdirSync(source);
      writeFileSync(
        join(source, 'tool.js'),
        '#!/usr/bin/env node\nconsole.log("fixture source OK");\n',
      );
      const git = (args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
          {
            cwd: source,
            encoding: 'utf8',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
          },
        );
      git(['init']);
      git(['add', 'tool.js']);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Fixture',
      ]);
      const commit = git(['rev-parse', 'HEAD']).trim();
      const payload = '#!/bin/sh\nprintf "fixture release OK\\n"\n';
      writeFileSync(join(context, 'release-tool'), payload);
      writeFileSync(join(context, 'agent-shim.sh'), AGENT_SHIM_SCRIPT);
      const checksum = createHash('sha256').update(payload).digest('hex');
      execFileSync('tar', [
        '-czf',
        join(context, 'release.tar.gz'),
        '-C',
        context,
        './release-tool',
      ]);
      const archiveChecksum = createHash('sha256')
        .update(readFileSync(join(context, 'release.tar.gz')))
        .digest('hex');
      // Intercept only the fixture's public release URL, retaining actual checksum and tar behavior.
      writeFileSync(
        join(context, 'curl'),
        '#!/bin/sh\nset -eu\noutput=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then shift; output="$1"; fi\n  shift\ndone\ncp /home/autopod/fixture-release "$output"\n',
      );
      const baseCli = {
        description: 'Fixture CLI',
        instructions: 'Fixture only',
        verifyArgs: ['--help'],
      };
      const sourceCli = cliToolSchema.parse({
        ...baseCli,
        name: 'fixture-source-tool',
        source: {
          type: 'github-source',
          repository: 'autopod-fixture/source',
          commit,
          executable: 'dist/tool.js',
          buildCommands: ['mkdir dist && cp tool.js dist/tool.js'],
        },
      });
      const releaseCli = cliToolSchema.parse({
        ...baseCli,
        name: 'fixture-release-tool',
        source: {
          type: 'github-release',
          repository: 'autopod-fixture/release',
          tag: 'v1',
          assets: [{ platform: 'linux/amd64', asset: 'tool', sha256: checksum, format: 'binary' }],
        },
      });
      const npmCli = cliToolSchema.parse({
        ...baseCli,
        name: 'fixture-cowsay',
        verifyArgs: ['--version'],
        source: { type: 'npm', package: 'cowsay', version: '1.6.0', executable: 'cowsay' },
      });
      const archiveCli = cliToolSchema.parse({
        ...releaseCli,
        name: 'fixture-archive-tool',
        source: {
          type: 'github-release',
          repository: 'autopod-fixture/release',
          tag: 'v1',
          assets: [
            {
              platform: 'linux/amd64',
              asset: 'tool.tar.gz',
              sha256: archiveChecksum,
              format: 'tar.gz',
              executable: './release-tool',
            },
          ],
        },
      });
      const commands = cliToolInstallCommands([sourceCli, releaseCli, npmCli], 'linux/amd64');
      writeFileSync(
        join(context, 'Dockerfile'),
        [
          `FROM ${baseTag}`,
          'USER root',
          'COPY --chown=autopod:autopod source /home/autopod/fixture-source',
          'COPY --chown=autopod:autopod release-tool /home/autopod/fixture-release',
          'COPY --chown=autopod:autopod agent-shim.sh /home/autopod/fixture-agent-shim.sh',
          'COPY --chown=autopod:autopod release.tar.gz /home/autopod/fixture-release-archive',
          'COPY --chown=autopod:autopod curl /home/autopod/fixture-bin/curl',
          'RUN chmod 0755 /home/autopod/fixture-bin/curl',
          'USER autopod',
          'ENV PATH="/home/autopod/fixture-bin:/home/autopod/.local/bin:$PATH"',
          'RUN git config --global protocol.file.allow always && git config --global url.file:///home/autopod/fixture-source/.insteadOf https://github.com/autopod-fixture/source.git',
          ...commands.map((command) => `RUN ${JSON.stringify(['sh', '-e', '-c', command])}`),
          '',
        ].join('\n'),
      );
      docker(['build', '--tag', tag, context]);
      docker([
        'run',
        '--detach',
        '--name',
        container,
        '--network=none',
        '--entrypoint',
        'sleep',
        tag,
        '300',
      ]);
      expect(docker(['exec', container, 'id', '-un']).trim()).toBe('autopod');
      expect(docker(['exec', container, 'fixture-source-tool', '--help'])).toContain(
        'fixture source OK',
      );
      expect(docker(['exec', container, 'fixture-release-tool', '--help'])).toContain(
        'fixture release OK',
      );
      expect(docker(['exec', container, 'fixture-cowsay', '--version'])).toContain('1.6.0');
      docker([
        'exec',
        container,
        'cp',
        '/home/autopod/fixture-release-archive',
        '/home/autopod/fixture-release',
      ]);
      docker([
        'exec',
        container,
        'sh',
        '-e',
        '-c',
        cliToolInstallCommands([archiveCli], 'linux/amd64')[0] ?? '',
      ]);
      expect(docker(['exec', container, 'fixture-archive-tool', '--help'])).toContain(
        'fixture release OK',
      );
      expect(
        docker([
          'exec',
          '--env',
          'PATH=/usr/local/bin:/usr/bin:/bin',
          '--env',
          'AUTOPOD_AGENT_PID_PATH=/tmp/cli-fixture-agent.pid',
          container,
          'sh',
          '/home/autopod/fixture-agent-shim.sh',
          'fixture-source-tool',
          '--help',
        ]),
      ).toContain('fixture source OK');
      const corrupted = cliToolSchema.parse({
        ...releaseCli,
        name: 'fixture-corrupt-tool',
        source: {
          ...releaseCli.source,
          assets: [
            { platform: 'linux/amd64', asset: 'tool', sha256: '0'.repeat(64), format: 'binary' },
          ],
        },
      });
      expect(() =>
        docker([
          'exec',
          container,
          'sh',
          '-e',
          '-c',
          cliToolInstallCommands([corrupted], 'linux/amd64')[0] ?? '',
        ]),
      ).toThrow();
      expect(() =>
        docker(['exec', container, 'test', '-e', '/home/autopod/.local/bin/fixture-corrupt-tool']),
      ).toThrow();
      const badProbe = cliToolSchema.parse({
        ...sourceCli,
        name: 'fixture-failed-probe',
        verifyArgs: ['--help'],
        source: {
          ...sourceCli.source,
          buildCommands: ["mkdir dist && printf '#!/bin/sh\\nexit 7\\n' > dist/tool.js"],
        },
      });
      expect(() =>
        docker([
          'exec',
          container,
          'sh',
          '-e',
          '-c',
          cliToolInstallCommands([badProbe], 'linux/amd64')[0] ?? '',
        ]),
      ).toThrow();
    } finally {
      try {
        docker(['rm', '--force', container]);
      } catch {
        /* May not have reached run. */
      }
      try {
        docker(['image', 'rm', '--force', tag]);
      } catch {
        /* May not have reached build. */
      }
      try {
        docker(['image', 'rm', baseTag]);
      } catch {
        /* May not have reached tag. */
      }
      rmSync(context, { recursive: true, force: true });
    }
  },
  240_000,
);
