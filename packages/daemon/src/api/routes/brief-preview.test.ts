import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import type { PodManager } from '../../pods/index.js';
import type { ProfileStore } from '../../profiles/profile-store.js';
import { seriesRoutes } from './series.js';

const contractYaml = `
contract_version: 1
title: Contract brief
depends_on: []
scenarios:
  - id: scenario-ui
    given:
      - A user opens the app
    when:
      - The sheet renders
    then:
      - The brief source controls are available
required_facts:
  - id: fact-preview
    proves:
      - scenario-ui
    kind: unit-test
    artifact:
      path: packages/daemon/src/api/routes/brief-preview.test.ts
      change: update
    command: npx vitest run packages/daemon/src/api/routes/brief-preview.test.ts
human_review:
  - id: review-copy
    covers:
      - scenario-ui
    criterion: Preview copy is clear
    reason: This is a small UX judgment
`;

function createApp(
  params: {
    profileStore?: Partial<ProfileStore>;
    worktreeManager?: Partial<WorktreeManager>;
  } = {},
) {
  const app = Fastify();
  seriesRoutes(
    app,
    {} as PodManager,
    (params.profileStore ?? {}) as ProfileStore,
    (params.worktreeManager ?? {}) as WorktreeManager,
  );
  return app;
}

describe('single brief preview routes', () => {
  it('previews a local /prep folder containing brief.md and contract.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopod-brief-'));
    try {
      writeFileSync(join(dir, 'brief.md'), 'Build the brief picker.');
      writeFileSync(join(dir, 'contract.yaml'), contractYaml);
      const app = createApp();

      const response = await app.inject({
        method: 'POST',
        url: '/pods/brief/preview',
        payload: { folderPath: dir },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.title).toBe('Contract brief');
      expect(body.task).toBe('Build the brief picker.');
      expect(body.contract.requiredFacts[0].id).toBe('fact-preview');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects local briefs whose contract is too long for pod creation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopod-brief-'));
    try {
      writeFileSync(join(dir, 'brief.md'), 'Build the brief picker.');
      writeFileSync(
        join(dir, 'contract.yaml'),
        contractYaml.replace('Preview copy is clear', 'a'.repeat(501)),
      );
      const app = createApp();

      const response = await app.inject({
        method: 'POST',
        url: '/pods/brief/preview',
        payload: { folderPath: dir },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain(
        'human_review[0].criterion must contain at most 500 character(s)',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects local folders with multiple contract briefs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopod-briefs-'));
    try {
      const first = join(dir, '01-first');
      const second = join(dir, '02-second');
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(join(first, 'brief.md'), 'First');
      writeFileSync(join(first, 'contract.yaml'), contractYaml);
      writeFileSync(join(second, 'brief.md'), 'Second');
      writeFileSync(join(second, 'contract.yaml'), contractYaml);
      const app = createApp();

      const response = await app.inject({
        method: 'POST',
        url: '/pods/brief/preview',
        payload: { folderPath: dir },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('MULTIPLE_BRIEFS_FOUND');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('previews a branch /prep folder through the profile repo', async () => {
    const profileStore = {
      get: vi.fn().mockReturnValue({ name: 'app', repoUrl: 'https://github.com/org/app' }),
    };
    const worktreeManager = {
      readBranchFolder: vi.fn().mockResolvedValue({
        relPath: 'specs/pick-brief',
        files: [
          {
            filename: 'pick-brief',
            content: 'Build from branch.',
            contractContent: contractYaml,
          },
        ],
        purposeMd: '',
        designMd: '',
      }),
    };
    const app = createApp({ profileStore, worktreeManager });

    const response = await app.inject({
      method: 'POST',
      url: '/pods/brief/preview-branch',
      payload: {
        profileName: 'app',
        branch: 'feature/prep',
        path: 'specs/pick-brief',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().contract.title).toBe('Contract brief');
    expect(worktreeManager.readBranchFolder).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/org/app',
      branch: 'feature/prep',
      relPath: 'specs/pick-brief',
      pat: undefined,
    });
  });
});
