import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { referenceImage } from '../test-utils/reference-image-helpers.js';
import { inputBundleVerificationCommand } from './input-bundle-delivery.js';
import { InputBundleStore } from './input-bundle-store.js';

const image = process.env.AUTOPOD_INPUT_DOCKER_IMAGE;
/** Explicit opt-in: uses an already-present content-pinned trusted image; no registry pulls/auth. */
describe.skipIf(!image)('real Docker reference isolation', () => {
  it('delivers exact bytes read-only to a non-root container with no network and no source pollution', async () => {
    if (!image || !/^(sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(image))
      throw new Error('Use a local content-pinned Docker image');
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10_000 });
    const root = await mkdtemp(
      path.join(process.env.AUTOPOD_INPUT_DOCKER_TMP ?? tmpdir(), 'autopod-input-docker-'),
    );
    const name = `autopod-input-fixture-${randomUUID()}`;
    const db = createTestDb();
    try {
      const store = new InputBundleStore(db);
      const bytes = referenceImage().bytes;
      const upload = store.create(
        {
          requestKey: randomUUID(),
          files: [
            {
              path: 'design.png',
              mediaType: 'image/png',
              byteLength: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        },
        'fixture',
      );
      store.put(upload.id, 'fixture', 0, bytes);
      const { status: _, ...ref } = store.seal(upload.id, 'fixture');
      const inputs = await store.materialize(ref, 'fixture', root);
      const workspace = path.join(root, 'workspace');
      await mkdir(workspace);
      await chmod(workspace, 0o777);
      await writeFile(path.join(workspace, 'README.md'), 'Source, not reference input\n');
      execFileSync('git', ['init', '-q', workspace]);
      execFileSync('git', ['-C', workspace, 'add', '.']);
      execFileSync('git', [
        '-C',
        workspace,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'Initial',
      ]);
      const command = inputBundleVerificationCommand(ref);
      const script = `${command[2]}\nassert os.statvfs(root).f_flag & os.ST_RDONLY\nassert pathlib.Path('/workspace/README.md').read_text() == 'Source, not reference input\\n'\nassert not pathlib.Path('/workspace/design.png').exists()\ntry:\n (root/'files'/'design.png').write_bytes(b'changed')\n raise RuntimeError('input writable')\nexcept PermissionError: pass\nexcept OSError as error:\n if error.errno != 30: raise\nprint('REFERENCE_DELIVERY_VERIFIED')\n`;
      const output = execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--label',
          'autopod.fixture=input-attachments',
          '--user',
          '1000:1000',
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '128m',
          '--pids-limit',
          '64',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,noexec,size=16m',
          '--mount',
          `type=bind,src=${inputs},dst=/autopod/inputs,readonly`,
          '--mount',
          `type=bind,src=${workspace},dst=/workspace`,
          '--entrypoint',
          'python3',
          image,
          '-c',
          script,
          ...command.slice(3),
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(output).toContain('REFERENCE_DELIVERY_VERIFIED');
      expect(await readFile(path.join(inputs, 'files/design.png'))).toEqual(bytes);
      expect(
        execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }),
      ).toBe('');
    } finally {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10_000 });
      } catch {
        /* --rm may already have cleaned this fixture. */
      }
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
