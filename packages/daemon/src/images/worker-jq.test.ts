import { execFile, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const templates = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../templates',
);
const checker = path.join(templates, 'base/check-worker-jq.sh');
const workers: string[] = [];
for (const directory of ['base', 'managed']) {
  for (const name of await readdir(path.join(templates, directory))) {
    if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) {
      workers.push(`${directory}/${name}`);
    }
  }
}
workers.sort();

// Only a package-owned real jq qualifies. Missing prerequisites are an explicit skip.
// biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query format syntax
const realJq = spawnSync('dpkg-query', ['-W', '-f=${Status}', 'jq'], { encoding: 'utf8' });
const jqAvailable =
  realJq.status === 0 &&
  realJq.stdout === 'install ok installed' &&
  spawnSync('/usr/bin/jq', ['--version']).status === 0;

describe('real jq in every coding-worker image', () => {
  it('discovers both worker image directories', () => {
    expect(workers.filter((name) => name.startsWith('base/')).length).toBeGreaterThanOrEqual(14);
    expect(workers.filter((name) => name.startsWith('managed/')).length).toBeGreaterThanOrEqual(2);
  });

  it.each(workers)('%s installs distro jq and probes it as the final worker', async (name) => {
    const source = await readFile(path.join(templates, name), 'utf8');
    const instructions = source
      .replace(/\\\n/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const install = instructions.findIndex(
      (line) => /^RUN /.test(line) && /apt-get install\s+[^;&|]*\bjq\b/.test(line),
    );
    const copy = instructions.indexOf(
      'COPY templates/base/check-worker-jq.sh /usr/local/bin/autopod-check-jq',
    );
    const chmod = instructions.indexOf('RUN chmod 0755 /usr/local/bin/autopod-check-jq');
    const probe = instructions.indexOf('RUN autopod-check-jq');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(copy).toBeGreaterThan(install);
    expect(chmod).toBeGreaterThan(copy);
    expect(probe).toBeGreaterThan(chmod);
    const users = instructions.filter((line) => line.startsWith('USER '));
    expect(users.at(-1)).toBe('USER autopod');
    expect(
      instructions
        .slice(0, probe)
        .filter((line) => line.startsWith('USER '))
        .at(-1),
    ).toBe(users.at(-1));
    expect(instructions.slice(probe + 1).some((line) => /^(USER|FROM) /.test(line))).toBe(false);
  });

  it('keeps JSON transformation and exit-status assertions in the wired probe', async () => {
    const script = await readFile(checker, 'utf8');
    expect(script).toContain('set -eu');
    expect(script).toContain('test "$(id -u)" -ne 0');
    expect(script).toContain('dpkg-query -W');
    expect(script).toContain('/usr/bin/jq -ce');
    expect(script).toContain('select(.enabled)');
    expect(script).toContain('test "$result" =');
    expect(script).toContain('/usr/bin/jq -e');
    expect(script).toContain('for value in false null');
    expect(script).toContain('test "$status" -eq 1');
  });

  it.skipIf(!jqAvailable || process.getuid?.() === 0)(
    'runs the shared probe with real distro jq as a non-root user (otherwise NOT RUN)',
    async () => {
      await expect(exec('sh', [checker])).resolves.toMatchObject({ stdout: '', stderr: '' });
    },
  );
});
