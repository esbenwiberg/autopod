import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const base = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../templates/base',
);
const checker = path.join(base, 'check-worker-git.sh');

describe('durable PostgreSQL worker Git', () => {
  it.each(['node22-pw-pg', 'node24-pw-pg'])(
    '%s installs Git and checks it as the worker',
    async (name) => {
      const dockerfile = await readFile(path.join(base, `Dockerfile.${name}`), 'utf8');
      expect(dockerfile).toContain('libcurl4-openssl-dev libexpat1-dev libssl-dev zlib1g-dev');
      expect(dockerfile).toContain(
        'COPY templates/base/install-worker-git.sh /tmp/install-worker-git.sh',
      );
      expect(dockerfile).toContain('RUN sh /tmp/install-worker-git.sh');
      expect(dockerfile).toContain(
        'COPY templates/base/check-worker-git.sh /usr/local/bin/autopod-check-git',
      );
      expect(dockerfile).toContain('USER autopod\nRUN autopod-check-git');
    },
  );

  it('pins and verifies the upstream archive before extraction or compilation', async () => {
    const script = await readFile(path.join(base, 'install-worker-git.sh'), 'utf8');
    expect(script).toContain('version=2.56.0');
    expect(script).toContain(
      'sha256=826817fd3671b8565586d6d49f688298de8354ab11db829c02720e5c74b9b39f',
    );
    expect(script).toContain('https://www.kernel.org/pub/software/scm/git/git-$version.tar.gz');
    expect(script.indexOf('sha256sum -c -')).toBeLessThan(script.indexOf('tar -xzf'));
    expect(script.indexOf('tar -xzf')).toBeLessThan(script.indexOf('make -C'));
    expect(script.match(/NO_RUST=YesPlease/g)).toHaveLength(2);
    expect(script).toContain('test -x /usr/local/libexec/git-core/git-remote-https');
    expect(script).not.toContain('NO_CURL');
    expect(script).not.toContain('|| true');
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses to install tools in an ordinary non-root worker',
    async () => {
      await expect(exec('sh', [path.join(base, 'install-worker-git.sh')])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('only as root while building the base image'),
      });
    },
  );

  it.each(['supported', 'old-git'] as const)(
    'proves the real operation and cleans its fixture: %s',
    async (mode) => {
      const root = await mkdtemp(path.join(tmpdir(), 'worker-git-test-'));
      try {
        const temporary = path.join(root, 'temporary data');
        const bin = path.join(root, 'bin');
        await mkdir(temporary);
        await mkdir(bin);
        const index = path.join(root, 'caller-index');
        await writeFile(index, 'caller data must not change');
        const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
        const wrapper = path.join(bin, 'git');
        await writeFile(
          wrapper,
          `#!/bin/sh
if [ "$1" = --version ]; then echo 'git version fixture'; exit 0; fi
${mode === 'old-git' ? `for arg in "$@"; do case "$arg" in --merge-base=*) echo 'unsupported option' >&2; exit 129;; esac; done` : ':'}
exec ${JSON.stringify(realGit)} "$@"
`,
        );
        await chmod(wrapper, 0o755);
        const result = exec('sh', [checker], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TMPDIR: temporary,
            GIT_DIR: '/not-the-fixture/.git',
            GIT_WORK_TREE: '/not-the-fixture',
            GIT_COMMON_DIR: '/not-the-fixture/common',
            GIT_INDEX_FILE: index,
            GIT_OBJECT_DIRECTORY: '/not-the-fixture/objects',
            GIT_ALTERNATE_OBJECT_DIRECTORIES: '/not-the-fixture/alternates',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.repositoryformatversion',
            GIT_CONFIG_VALUE_0: '99999',
          },
        });
        if (mode === 'supported') {
          await expect(result).resolves.toMatchObject({ stdout: 'git version fixture\n' });
        } else {
          await expect(result).rejects.toMatchObject({
            code: 1,
            stderr: expect.stringContaining('lacks the required merge-tree --merge-base operation'),
          });
        }
        expect(await readdir(temporary)).toEqual([]);
        expect(await readFile(index, 'utf8')).toBe('caller data must not change');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
