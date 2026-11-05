import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { InputBundleStore } from '../inputs/input-bundle-store.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { deriveLaunch } from './derive-launch.js';
import { configurationDigest, resolveLaunch } from './launch-resolver.js';

const databases: ReturnType<typeof createTestDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe('launch-bound reference attachments', () => {
  it('requires sealed owner authorization and includes exact references in the frozen launch digest', async () => {
    const db = createTestDb();
    databases.push(db);
    const { services } = createTestConfiguration(db);
    const store = new InputBundleStore(db);
    const bytes = Buffer.from('Wireframe source');
    const upload = store.create(
      {
        requestKey: randomUUID(),
        files: [
          {
            path: 'design.html',
            mediaType: 'text/html',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      'owner',
    );
    services.assertInputBundle = (ref, owner) => store.assert(ref, owner ?? '');
    const { status: _, ...ref } = upload;
    const request = {
      repositoryId: 'repo-a',
      task: 'Build the design',
      work: { inputBundle: ref },
    };
    await expect(resolveLaunch(request, services, 'owner')).rejects.toThrow('Seal reference');
    store.put(upload.id, 'owner', 0, bytes);
    store.seal(upload.id, 'owner');
    await expect(resolveLaunch(request, services, 'other')).rejects.toThrow('not found');
    const config = await resolveLaunch(request, services, 'owner');
    expect(config.work.inputBundle).toEqual(ref);
    const plain = await resolveLaunch(
      { repositoryId: 'repo-a', task: request.task },
      services,
      'owner',
    );
    expect(config.digest).not.toBe(plain.digest);
    for (const kind of ['follow-up', 'fix', 'manual-fix', 'spawn-worker'] as const) {
      const parent =
        kind === 'spawn-worker'
          ? { ...config, workflow: { ...config.workflow, agentMode: 'interactive' as const } }
          : config;
      const child = deriveLaunch(parent, {
        source: { podId: 'parent', digest: parent.digest, kind },
        task: 'Continue',
      });
      expect(child.work.inputBundle).toEqual(ref);
    }
    const { digest: _oldDigest, ...interactive } = {
      ...config,
      workflow: { ...config.workflow, agentMode: 'interactive' as const },
      worker: plain,
    };
    const workspace = { ...interactive, digest: configurationDigest(interactive) };
    for (const kind of ['worker', 'spawn-worker'] as const) {
      const worker = deriveLaunch(workspace, {
        source: { podId: 'workspace', digest: workspace.digest, kind },
        task: 'Implement using the workspace design',
      });
      expect(worker.work.inputBundle).toEqual(ref);
    }
    const cleared = deriveLaunch(config, {
      source: { podId: 'parent', digest: config.digest, kind: 'follow-up' },
      task: 'New task',
      work: { inputBundle: null },
    });
    expect(cleared.work.inputBundle).toBeNull();
    services.readLaunch = () => config;
    const current = {
      repositoryId: 'repo-a',
      task: 'New profile, same design',
      source: { podId: 'parent', digest: config.digest, configuration: 'current' as const },
    };
    expect((await resolveLaunch(current, services, 'owner')).work.inputBundle).toEqual(ref);
    expect(
      (await resolveLaunch({ ...current, work: { inputBundle: null } }, services, 'owner')).work
        .inputBundle,
    ).toBeNull();
    services.assertInputBundle = undefined;
    await expect(resolveLaunch(request, services, 'owner')).rejects.toThrow('unavailable');
  });
});
