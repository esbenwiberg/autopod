import { type SpecContract, parseSpecContract } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import {
  ADVISORY_BROWSER_QA_TARGET_CAP,
  buildAdvisoryChecklistTargets,
  runAdvisoryBrowserQa,
} from './advisory-browser-qa-runner.js';
import type { HostBrowserRunner } from './host-browser-runner.js';

function contractYaml(extraScenarios = ''): string {
  return `contract_version: 1
title: Advisory QA
depends_on: []
scenarios:
  - id: dashboard
    given: ["a user has data"]
    when: ["they open the dashboard"]
    then: ["the summary is visible"]
${extraScenarios}required_facts: []
human_review:
  - id: visual-state
    covers: [dashboard]
    criterion: "The empty state is not shown over loaded data."
    reason: "This requires visual inspection."
`;
}

function browserStdout(entries: unknown[]): string {
  return `noise
AUTOPOD_ADVISORY_BROWSER_QA_JSON_START
${JSON.stringify(entries)}
AUTOPOD_ADVISORY_BROWSER_QA_JSON_END
`;
}

function createHostBrowserRunner(stdout: string, exitCode = 0): HostBrowserRunner {
  return {
    getAvailability: vi.fn(async () => ({
      available: true,
      cached: false,
      checkedAt: '2026-05-25T00:00:00.000Z',
      reason: 'ok',
      playwrightPackagePath: '/repo/node_modules/playwright/index.js',
      playwrightCwd: '/repo',
      chromiumExecutablePath: '/chrome',
    })),
    isAvailable: vi.fn(async () => true),
    runScript: vi.fn(async () => ({ stdout, stderr: 'script stderr', exitCode })),
    readScreenshot: vi.fn(async () => Buffer.from('png').toString('base64')),
    cleanup: vi.fn(async () => {}),
    screenshotDir: vi.fn(() => '/tmp/advisory/screenshots'),
  };
}

function createSequentialHostBrowserRunner(
  runs: Array<{ stdout: string; exitCode?: number }>,
): HostBrowserRunner {
  let index = 0;
  return {
    getAvailability: vi.fn(async () => ({
      available: true,
      cached: false,
      checkedAt: '2026-05-25T00:00:00.000Z',
      reason: 'ok',
      playwrightPackagePath: '/repo/node_modules/playwright/index.js',
      playwrightCwd: '/repo',
      chromiumExecutablePath: '/chrome',
    })),
    isAvailable: vi.fn(async () => true),
    runScript: vi.fn(async () => {
      const run = runs[Math.min(index, runs.length - 1)] ?? { stdout: browserStdout([]) };
      index += 1;
      return { stdout: run.stdout, stderr: 'script stderr', exitCode: run.exitCode ?? 0 };
    }),
    readScreenshot: vi.fn(async (path) => Buffer.from(`png:${path}`).toString('base64')),
    cleanup: vi.fn(async () => {}),
    screenshotDir: vi.fn(() => '/tmp/advisory/screenshots'),
  };
}

function browserFrame(
  label: string,
  path: string,
  controls: unknown[] = [],
  action?: unknown,
): Record<string, unknown> {
  return {
    label,
    url: 'http://127.0.0.1:3000/',
    title: 'Dashboard',
    notes: [`${label} body text`],
    screenshotPath: path,
    accessibility: { role: 'WebArea', name: 'Portfolio simulation' },
    controls,
    action,
  };
}

function createScreenshotStore(): ScreenshotStore {
  return {
    write: vi.fn(async (podId, source, filename) => ({
      podId,
      source,
      filename,
      relativePath: `screenshots/${podId}/${source}/${filename}`,
    })),
    read: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  } as unknown as ScreenshotStore;
}

describe('buildAdvisoryChecklistTargets', () => {
  it('caps scenarios plus human review items at five targets', () => {
    const contract: SpecContract = {
      contractVersion: 1,
      title: 'Cap',
      dependsOn: [],
      scenarios: Array.from({ length: 8 }, (_, i) => ({
        id: `scenario-${i}`,
        given: ['state'],
        when: ['action'],
        // biome-ignore lint/suspicious/noThenProperty: contract scenarios intentionally use Given/When/Then.
        then: ['result'],
      })),
      requiredFacts: [],
      humanReview: [
        {
          id: 'visual-state',
          covers: ['scenario-0'],
          criterion: 'Looks right',
          reason: 'Needs a browser',
        },
      ],
    };

    const targets = buildAdvisoryChecklistTargets(contract);

    expect(targets).toHaveLength(ADVISORY_BROWSER_QA_TARGET_CAP);
    expect(targets.map((target) => target.id)).toEqual([
      'scenario:scenario-0',
      'scenario:scenario-1',
      'scenario:scenario-2',
      'scenario:scenario-3',
      'scenario:scenario-4',
    ]);
  });
});

describe('runAdvisoryBrowserQa', () => {
  it('returns complete advisory evidence with screenshots', async () => {
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
        {
          targetId: 'scenario:dashboard',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Summary visible'],
          screenshotPath: '/tmp/advisory/screenshots/advisory-0.png',
        },
      ]),
    );
    const screenshotStore = createScreenshotStore();

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-1',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      reviewerModel: 'review-model',
      hostBrowserRunner,
      screenshotStore,
      reviewer: {
        review: vi.fn(async () => ({
          status: 'pass',
          reasoning: 'Looks usable',
          observations: [
            {
              id: 'dashboard-ok',
              targetId: 'scenario:dashboard',
              status: 'pass',
              summary: 'Dashboard summary is visible.',
            },
          ],
        })),
      },
    });

    expect(result.status).toBe('pass');
    expect(result.screenshots[0]?.relativePath).toBe('screenshots/pod-1/advisory/advisory-0.png');
    expect(result.observations[0]).toMatchObject({
      id: 'dashboard-ok',
      scenarioId: 'dashboard',
      status: 'pass',
      screenshots: [result.screenshots[0]],
    });
    expect(screenshotStore.write).toHaveBeenCalledWith(
      'pod-1',
      'advisory',
      'advisory-0.png',
      expect.any(Buffer),
    );
  });

  it('skips with no-contract-checklist when scenarios and human review are empty', async () => {
    const result = await runAdvisoryBrowserQa({
      podId: 'pod-1',
      task: 'No checklist',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(`contract_version: 1
title: Empty
depends_on: []
scenarios: []
required_facts: []
human_review: []
`),
      hostBrowserRunner: createHostBrowserRunner(browserStdout([])),
      screenshotStore: createScreenshotStore(),
      reviewer: { review: vi.fn() },
    });

    expect(result).toMatchObject({
      status: 'skip',
      reasoning: 'no-contract-checklist',
      observations: [],
      screenshots: [],
    });
  });

  it('records reviewer concerns as advisory failures', async () => {
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
        {
          targetId: 'human_review:visual-state',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Empty state and data both visible'],
          screenshotPath: '/tmp/advisory/screenshots/advisory-1.png',
        },
      ]),
    );

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-2',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: {
        review: vi.fn(async () => ({
          status: 'fail',
          reasoning: 'Visual concern found',
          observations: [
            {
              id: 'empty-state-overlap',
              targetId: 'human_review:visual-state',
              status: 'fail',
              summary: 'Loaded data is overlapped by the empty state.',
              suggestedFacts: [
                'Add a browser-test proving the loaded dashboard hides empty state.',
              ],
            },
          ],
        })),
      },
    });

    expect(result.status).toBe('fail');
    expect(result.reasoning).toBe('Visual concern found');
    expect(result.observations[0]?.suggestedFacts).toEqual([
      'Add a browser-test proving the loaded dashboard hides empty state.',
    ]);
  });

  it('passes screenshot bytes, accessibility, and visible controls to the reviewer', async () => {
    const review = vi.fn(async (input) => {
      const frame = input.browserObservations[0]?.frames[0];
      expect(frame?.imageLabel).toBe('Image 1');
      expect(frame?.screenshotBase64).toBe(
        Buffer.from('png:/tmp/advisory/screenshots/help-initial.png').toString('base64'),
      );
      expect(frame?.accessibility).toMatchObject({ role: 'WebArea' });
      expect(frame?.controls?.[0]).toMatchObject({ role: 'button', ariaLabel: 'Help' });
      return {
        status: 'pass' as const,
        reasoning: 'Help is visible',
        observations: [
          {
            id: 'help-visible',
            targetId: 'scenario:dashboard',
            status: 'pass' as const,
            summary: 'Help button is visible and accessible.',
          },
        ],
      };
    });
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [
              browserFrame('initial', '/tmp/advisory/screenshots/help-initial.png', [
                {
                  index: 0,
                  role: 'button',
                  tag: 'button',
                  text: '?',
                  ariaLabel: 'Help',
                  title: '',
                  disabled: false,
                  visible: true,
                  rect: { x: 10, y: 20, width: 24, height: 24 },
                },
              ]),
            ],
          },
        ]),
      },
    ]);

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-visual',
      task: 'Check dashboard visuals',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
    });

    expect(result.status).toBe('pass');
    expect(review).toHaveBeenCalledOnce();
  });

  it('reuses repeated screenshot bytes in storage and reviewer image attachments', async () => {
    const review = vi.fn(async (input) => {
      const frames = input.browserObservations.flatMap((observation) => observation.frames);
      expect(frames[0]?.imageLabel).toBe('Image 1');
      expect(frames[1]?.imageLabel).toBeUndefined();
      expect(frames.every((frame) => frame.screenshotBase64)).toBe(true);
      return {
        status: 'pass' as const,
        reasoning: 'Repeated page state inspected once',
        observations: [],
      };
    });
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
        {
          targetId: 'scenario:dashboard',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Scenario page'],
          screenshotPath: '/tmp/advisory/screenshots/scenario.png',
        },
        {
          targetId: 'human_review:visual-state',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Same page for human review'],
          screenshotPath: '/tmp/advisory/screenshots/human-review.png',
        },
      ]),
    );

    const screenshotStore = createScreenshotStore();

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-dedupe',
      task: 'Check repeated dashboard evidence',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      hostBrowserRunner,
      screenshotStore,
      reviewer: { review },
    });

    expect(result.status).toBe('pass');
    expect(result.screenshots).toHaveLength(1);
    expect(screenshotStore.write).toHaveBeenCalledOnce();
  });

  it('runs reviewer-planned browser actions and reviews the resulting frames', async () => {
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/initial.png')],
          },
        ]),
      },
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [
              browserFrame('initial', '/tmp/advisory/screenshots/action-initial.png'),
              browserFrame('after-action-1', '/tmp/advisory/screenshots/action-after.png', [], {
                status: 'pass',
                action: { type: 'click', controlIndex: 0, reason: 'Open Help' },
                summary: 'Clicked control',
              }),
            ],
          },
        ]),
      },
    ]);
    const planActions = vi.fn(async () => [
      {
        targetId: 'scenario:dashboard',
        actions: [{ type: 'click' as const, controlIndex: 0, reason: 'Open Help' }],
      },
    ]);
    const review = vi.fn(async (input) => {
      expect(input.browserObservations[0]?.frames).toHaveLength(2);
      expect(input.browserObservations[0]?.frames[1]?.action).toMatchObject({ status: 'pass' });
      return {
        status: 'pass' as const,
        reasoning: 'Dialog opened',
        observations: [
          {
            id: 'dialog-opened',
            targetId: 'scenario:dashboard',
            status: 'pass' as const,
            summary: 'Post-click frame shows the dialog.',
          },
        ],
      };
    });

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-actions',
      task: 'Open the help modal',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { planActions, review },
    });

    expect(result.status).toBe('pass');
    expect(hostBrowserRunner.runScript).toHaveBeenCalledTimes(2);
    expect(result.screenshots).toHaveLength(2);
  });

  it('uses the help-control heuristic before asking the reviewer to plan actions', async () => {
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [
              browserFrame('initial', '/tmp/advisory/screenshots/help-before.png', [
                {
                  index: 4,
                  role: 'button',
                  tag: 'button',
                  text: '?',
                  ariaLabel: 'Help',
                  title: '',
                  disabled: false,
                  visible: true,
                  rect: { x: 300, y: 20, width: 24, height: 24 },
                },
              ]),
            ],
          },
        ]),
      },
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [
              browserFrame('initial', '/tmp/advisory/screenshots/help-before-2.png'),
              browserFrame('after-action-1', '/tmp/advisory/screenshots/help-after.png', [], {
                status: 'pass',
                action: { type: 'click', controlIndex: 4, reason: 'Open Help' },
                summary: 'Clicked control',
              }),
            ],
          },
        ]),
      },
    ]);

    const planActions = vi.fn(async () => [
      {
        targetId: 'scenario:dashboard',
        actions: [{ type: 'click' as const, controlIndex: 99, reason: 'Wrong control' }],
      },
    ]);

    await runAdvisoryBrowserQa({
      podId: 'pod-help',
      task: 'Add a how-to-use help modal triggered from a new ? icon button',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: {
        planActions,
        review: vi.fn(async () => ({
          status: 'pass',
          reasoning: 'Help opened',
          observations: [],
        })),
      },
    });

    expect(hostBrowserRunner.runScript).toHaveBeenCalledTimes(2);
    expect(planActions).not.toHaveBeenCalled();
  });

  it('returns uncertain advisory evidence when browser execution errors', async () => {
    const result = await runAdvisoryBrowserQa({
      podId: 'pod-3',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      hostBrowserRunner: createHostBrowserRunner('not json', 1),
      screenshotStore: createScreenshotStore(),
      reviewer: { review: vi.fn() },
    });

    expect(result.status).toBe('uncertain');
    expect(result.reasoning).toContain('script failed');
    expect(result.observations).toEqual([]);
  });
});
