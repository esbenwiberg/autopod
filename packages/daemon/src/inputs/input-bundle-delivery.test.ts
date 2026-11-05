import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputBundleRefSchema } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { inputBundleVerificationCommand } from './input-bundle-delivery.js';

describe('trusted pre-agent reference verification', () => {
  it('checks actual filesystem bytes, rejects substitutions and never executes HTML', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'input-delivery-'));
    const root = await realpath(directory);
    try {
      const bytes = Buffer.from('<script>throw new Error("never execute")</script>');
      const ref = inputBundleRefSchema.parse({
        id: 'inputs-11111111-1111-4111-a111-111111111111',
        digest: 'a'.repeat(64),
        files: [
          {
            path: 'design/index.html',
            mediaType: 'text/html',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      });
      await mkdir(join(root, 'files/design'), { recursive: true });
      await writeFile(join(root, 'manifest.json'), JSON.stringify(ref));
      await writeFile(join(root, 'files/design/index.html'), bytes);
      const [command, ...args] = inputBundleVerificationCommand(ref, root);
      if (!command) throw new Error('Missing verification command');
      const verify = () => execFileSync(command, args, { stdio: 'pipe' });
      expect(verify).not.toThrow();
      await writeFile(join(root, 'files/design/index.html'), 'substituted');
      expect(verify).toThrow();
      await writeFile(join(root, 'files/design/index.html'), bytes);
      await symlink(join(root, 'manifest.json'), join(root, 'files/link.html'));
      expect(verify).toThrow();
      await rm(join(root, 'files/link.html'));
      await writeFile(join(root, 'files/extra.html'), 'not admitted');
      expect(verify).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
