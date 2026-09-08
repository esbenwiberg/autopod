import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
