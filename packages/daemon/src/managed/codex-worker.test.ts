import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
const worker = fileURLToPath(new URL('./runtime/codex_worker.py', import.meta.url));
it.each([66726, 98304, 98305])(
  'bounded README input forwards %i bytes or refuses before CLI startup',
  async (bytes) => {
    const root = await mkdtemp(path.join(tmpdir(), 'managed-worker-input-'));
    try {
      await writeFile(path.join(root, 'README.md'), 'x'.repeat(bytes));
      await writeFile(
        path.join(root, 'codex'),
        `#!/usr/bin/env python3\nimport pathlib,sys\nprompt=sys.stdin.read();pathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(str(len(prompt.split('Frozen README data follows:\\n',1)[1].encode())))\n`,
        { mode: 0o755 },
      );
      const result = exec(
        'python3',
        [
          worker,
          '--model',
          'gpt-5.6-terra',
          '--reasoning',
          'low',
          '--readme',
          path.join(root, 'README.md'),
          '--output',
          path.join(root, 'report.md'),
          '--',
          'Report facts',
        ],
        { env: { PATH: root + path.delimiter + process.env.PATH }, timeout: 10000 },
      );
      if (bytes > 98304) {
        await expect(result).rejects.toThrow('readme-too-large');
        await expect(access(path.join(root, 'report.md'))).rejects.toThrow();
      } else {
        await result;
        expect(await readFile(path.join(root, 'report.md'), 'utf8')).toBe(String(bytes));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('adds one bounded verified artifact file to the provider prompt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-worker-artifact-'));
  try {
    const input = path.join(root, 'input');
    await mkdir(input);
    await writeFile(path.join(root, 'README.md'), '# Repository');
    await writeFile(path.join(input, 'research.md'), '# Stage one\n\nExact handoff fact.');
    await writeFile(
      path.join(root, 'codex'),
      `#!/usr/bin/env python3\nimport pathlib,sys\nprompt=sys.stdin.read();pathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(prompt)\n`,
      { mode: 0o755 },
    );
    await exec(
      'python3',
      [
        worker,
        '--model',
        'gpt-5.6-terra',
        '--reasoning',
        'low',
        '--readme',
        path.join(root, 'README.md'),
        '--input-root',
        input,
        '--output',
        path.join(root, 'report.md'),
        '--',
        'Use the verified input',
      ],
      { env: { PATH: root + path.delimiter + process.env.PATH }, timeout: 10000 },
    );
    expect(await readFile(path.join(root, 'report.md'), 'utf8')).toContain(
      'Verified input artifact follows:\n# Stage one\n\nExact handoff fact.',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['multiple files', ['first', 'second']],
  ['more than 16 KiB', ['x'.repeat(16 * 1024 + 1)]],
])('rejects artifact input with %s before CLI startup', async (_case, contents) => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-worker-artifact-invalid-'));
  try {
    const input = path.join(root, 'input');
    await mkdir(input);
    await writeFile(path.join(root, 'README.md'), '# Repository');
    for (const [index, content] of contents.entries())
      await writeFile(path.join(input, `${index}.md`), content);
    await writeFile(
      path.join(root, 'codex'),
      '#!/usr/bin/env python3\nimport pathlib\npathlib.Path("cli-started").touch()\n',
      { mode: 0o755 },
    );
    const result = exec(
      'python3',
      [
        worker,
        '--model',
        'gpt-5.6-terra',
        '--reasoning',
        'low',
        '--readme',
        path.join(root, 'README.md'),
        '--input-root',
        input,
        '--output',
        path.join(root, 'report.md'),
        '--',
        'Use the verified input',
      ],
      { cwd: root, env: { PATH: root + path.delimiter + process.env.PATH }, timeout: 10000 },
    );
    await expect(result).rejects.toThrow();
    await expect(access(path.join(root, 'cli-started'))).rejects.toThrow();
    await expect(access(path.join(root, 'report.md'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
