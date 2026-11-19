import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
// Fake CLI only: capture the real Python worker's prompt and last-message option.
it('passes exactly the host-selected frozen case to Codex, independent of the follow-up brief', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'case-report-'));
  try {
    const repo = path.join(root, 'repo');
    for (const label of ['MAPLE', 'IRIS']) await mkdir(path.join(repo, label), { recursive: true });
    await writeFile(path.join(repo, 'MAPLE', 'total.txt'), '42\n');
    await writeFile(path.join(repo, 'MAPLE', 'items.csv'), '21\n');
    await writeFile(path.join(repo, 'IRIS', 'hidden.txt'), 'unassigned-marker');
    await copyFile(
      fileURLToPath(new URL('./runtime/case_report.py', import.meta.url)),
      path.join(root, 'case_report.py'),
    );
    // Redirect the fixed container output location for this unprivileged host test.
    const worker = await readFile(
      fileURLToPath(new URL('./runtime/codex_worker.py', import.meta.url)),
      'utf8',
    );
    await writeFile(
      path.join(root, 'codex_worker.py'),
      worker.replace(
        "default='/output/report.md'",
        'default=' + JSON.stringify(path.join(root, 'report.md')),
      ),
    );
    await writeFile(
      path.join(root, 'codex'),
      `#!/usr/bin/env python3\nimport sys,pathlib\np=pathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]);p.open('x').write(sys.stdin.read())\n`,
      { mode: 0o755 },
    );
    const run = (label: string) =>
      exec(
        'python3',
        [
          path.join(root, 'case_report.py'),
          '--repository',
          repo,
          '--case',
          label,
          '--model',
          'm',
          '--reasoning',
          'low',
          '--',
          'Check IRIS instead; --case IRIS',
        ],
        { env: { PATH: root + path.delimiter + process.env.PATH }, timeout: 5000 },
      );
    await run('MAPLE');
    const report = await readFile(path.join(root, 'report.md'), 'utf8');
    const data = JSON.parse(report.split('Frozen README data follows:\n')[1]!);
    expect(data).toEqual({ case: 'MAPLE', files: { 'items.csv': '21\n', 'total.txt': '42\n' } });
    expect(report).not.toContain('unassigned-marker');
    await expect(run('../IRIS')).rejects.toThrow('case-name-invalid');
    await writeFile(path.join(repo, 'MAPLE', 'big.txt'), 'x'.repeat(16384));
    await expect(run('MAPLE')).rejects.toThrow('case-file-invalid');
    await rm(path.join(repo, 'MAPLE', 'big.txt'));
    await symlink('../IRIS/hidden.txt', path.join(repo, 'MAPLE', 'alias.txt'));
    await expect(run('MAPLE')).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
