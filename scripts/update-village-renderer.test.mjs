import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateRenderer } from './update-village-renderer.mjs';

test('renderer rebuilds offline and a failed refresh preserves the last working bundle', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'village-update-test-'));
  try {
    const pinned = fileURLToPath(
      new URL('../packages/desktop/Sources/AutopodUI/Resources/Village/renderer', import.meta.url),
    );
    const output = path.join(temp, 'renderer');
    await fs.cp(pinned, output, { recursive: true });
    await updateRenderer({ output, check: true });
    const before = await fs.readFile(path.join(output, 'build.json'), 'utf8');
    const source = path.join(temp, 'source');
    await fs.cp(path.join(pinned, 'upstream'), source, { recursive: true });
    execFileSync('git', ['init', '-q', source]);
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Renderer Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ]);
    await fs.rm(path.join(source, 'public/assets/village-v3.png'));
    await assert.rejects(updateRenderer({ source, output }), /ENOENT/);
    assert.equal(await fs.readFile(path.join(output, 'build.json'), 'utf8'), before);
    await fs.copyFile(
      path.join(pinned, 'upstream/public/assets/village-v3.png'),
      path.join(source, 'public/assets/village-v3.png'),
    );
    const result = await updateRenderer({ source, output });
    assert.equal(result.dirty, false);
    await updateRenderer({ output, check: true });
    await fs.appendFile(path.join(output, 'renderer.js'), '\n// drift\n');
    await assert.rejects(updateRenderer({ output, check: true }), /out of date/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
