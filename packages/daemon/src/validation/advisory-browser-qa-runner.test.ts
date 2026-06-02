import { type SpecContract, parseSpecContract } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import {
  ADVISORY_BROWSER_QA_TARGET_CAP,
  buildAdvisoryChecklistTargets,
  runAdvisoryBrowserQa,
} from './advisory-browser-qa-runner.js';
import type { HostBrowserRunner } from './host-browser-runner.js';

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOpenAiApiKey === undefined) {
    Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  if (originalOpenAiBaseUrl === undefined) {
    Reflect.deleteProperty(process.env, 'OPENAI_BASE_URL');
  } else {
    process.env.OPENAI_BASE_URL = originalOpenAiBaseUrl;
  }
});

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

function scenarioOnlyContractYaml(extraScenarios = '', proves = ['dashboard']): string {
  const provesYaml = proves.map((id) => `"${id}"`).join(', ');
  return `contract_version: 1
title: Advisory QA
depends_on: []
scenarios:
  - id: dashboard
    given: ["a user has data"]
    when: ["they open the dashboard"]
    then: ["the summary is visible"]
${extraScenarios}required_facts:
  - id: browser-proof
    proves: [${provesYaml}]
    kind: browser-test
    artifact:
      path: tests/browser/advisory.spec.ts
      change: update
    command: npx vitest --run tests/browser/advisory.spec.ts --grep advisory-proof
human_review: []
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

function createContainerManager(stdout: string): ContainerManager {
  return {
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ''),
    execInContainer: vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 })),
  } as unknown as ContainerManager;
}

function rateLimitError(
  retryAfter?: string,
): Error & { status: number; headers?: Record<string, string> } {
  const err = new Error('429 rate limited') as Error & {
    status: number;
    headers?: Record<string, string>;
  };
  err.status = 429;
  if (retryAfter) err.headers = { 'retry-after': retryAfter };
  return err;
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
      contract: parseSpecContract(scenarioOnlyContractYaml()),
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
    const script = vi.mocked(hostBrowserRunner.runScript).mock.calls[0]?.[0];
    expect(script).toContain('viewport = { width: 1280, height: 900 }');
    expect(script).toContain('fullPage: false');
    expect(script).toContain("scale: 'css'");
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

  it('reviews advisory evidence through Claude CLI inside the pod for MAX profiles', async () => {
    const containerManager = createContainerManager(
      JSON.stringify({
        result: JSON.stringify({
          status: 'pass',
          reasoning: 'Container Claude reviewed structured evidence.',
          observations: [
            {
              id: 'container-claude-dashboard-ok',
              targetId: 'scenario:dashboard',
              status: 'pass',
              summary: 'The dashboard marker is visible in the structured browser evidence.',
            },
          ],
        }),
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
        total_cost_usd: 0.01,
      }),
    );

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-max-container',
      task: 'Check dashboard visuals',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      reviewerModel: 'claude-sonnet-4-6',
      reviewerProvider: 'max',
      reviewerProviderCredentials: {
        provider: 'max',
        accessToken: 'redacted',
        refreshToken: 'redacted',
        expiresAt: '2026-06-01T12:00:00.000Z',
      },
      containerManager,
      containerId: 'container-max',
      reviewerExecEnv: { POD_ID: 'pod-max-container' },
      hostBrowserRunner: createHostBrowserRunner(
        browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/container-claude.png')],
          },
        ]),
      ),
      screenshotStore: createScreenshotStore(),
    });

    expect(result.status).toBe('pass');
    expect(result.reasoning).toContain('Container Claude reviewed structured evidence.');
    expect(result.tokenUsage).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 5,
      costUsd: 0.01,
    });
    expect(containerManager.writeFile).toHaveBeenCalledWith(
      'container-max',
      expect.stringContaining('/tmp/autopod-claude-review-'),
      expect.stringContaining('You do not receive screenshot images'),
    );
    const execCommand = vi.mocked(containerManager.execInContainer).mock.calls[0]?.[1].join(' ');
    expect(execCommand).toContain('claude -p');
    expect(execCommand).toContain('--model');
    expect(execCommand).toContain('claude-sonnet-4-6');
  });

  it('reviews advisory evidence through Codex CLI inside the pod for ChatGPT auth profiles', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const containerManager = createContainerManager(
      JSON.stringify({
        status: 'pass',
        reasoning: 'Container Codex reviewed structured evidence.',
        observations: [
          {
            id: 'container-codex-dashboard-ok',
            targetId: 'scenario:dashboard',
            status: 'pass',
            summary: 'The dashboard marker is visible in the structured browser evidence.',
          },
        ],
      }),
    );

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-pro-container',
      task: 'Check dashboard visuals',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      reviewerModel: 'gpt-5',
      reviewerProvider: 'openai',
      reviewerProviderCredentials: { provider: 'openai', authMode: 'chatgpt', authJson: '{}' },
      containerManager,
      containerId: 'container-pro',
      hostBrowserRunner: createHostBrowserRunner(
        browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/container-codex.png')],
          },
        ]),
      ),
      screenshotStore: createScreenshotStore(),
    });

    expect(result.status).toBe('pass');
    expect(result.reasoning).toContain('Container Codex reviewed structured evidence.');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(containerManager.writeFile).toHaveBeenCalledWith(
      'container-pro',
      expect.stringContaining('/tmp/autopod-codex-review-'),
      expect.stringContaining('You do not receive screenshot images'),
    );
    const execCommand = vi.mocked(containerManager.execInContainer).mock.calls[0]?.[1].join(' ');
    expect(execCommand).toContain('codex exec');
    expect(execCommand).toContain('--model');
    expect(execCommand).toContain('gpt-5');
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
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Summary visible'],
            screenshotPath: '/tmp/advisory/screenshots/advisory-0.png',
          },
        ]),
      },
      {
        stdout: browserStdout([
          {
            targetId: 'human_review:visual-state',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Empty state and data both visible'],
            screenshotPath: '/tmp/advisory/screenshots/advisory-1.png',
          },
        ]),
      },
    ]);

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-2',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(contractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: {
        review: vi.fn(async (input) =>
          input.targets[0]?.id === 'human_review:visual-state'
            ? {
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
              }
            : {
                status: 'pass',
                reasoning: 'Scenario passes',
                observations: [],
              },
        ),
      },
      pauseBetweenTargetsMs: 0,
    });

    expect(result.status).toBe('fail');
    expect(result.reasoning).toContain('Visual concern found');
    expect(
      result.observations.find((observation) => observation.status === 'fail')?.suggestedFacts,
    ).toEqual(['Add a browser-test proving the loaded dashboard hides empty state.']);
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
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
    });

    expect(result.status).toBe('pass');
    expect(review).toHaveBeenCalledOnce();
  });

  it('sends advisory screenshots to OpenAI Responses image input', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-advisory';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: Array<{
          content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
        }>;
      };
      const content = body.input[0]?.content ?? [];
      expect(body.model).toBe('gpt-5-mini');
      expect(content.some((part) => part.type === 'input_text')).toBe(true);
      if (!content.some((part) => part.type === 'input_image')) {
        return new Response(JSON.stringify({ output_text: JSON.stringify({ actions: [] }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(content).toContainEqual(
        expect.objectContaining({
          type: 'input_image',
          image_url: `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
          detail: 'high',
        }),
      );
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            status: 'pass',
            reasoning: 'OpenAI saw the advisory screenshot.',
            observations: [
              {
                id: 'openai-dashboard-ok',
                targetId: 'scenario:dashboard',
                status: 'pass',
                summary: 'The dashboard marker is visible in the screenshot.',
              },
            ],
          }),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-openai-vision',
      task: 'Check dashboard visuals',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      reviewerModel: 'auto',
      reviewerProvider: 'openai',
      hostBrowserRunner: createHostBrowserRunner(
        browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/openai.png')],
          },
        ]),
      ),
      screenshotStore: createScreenshotStore(),
    });

    expect(result.status).toBe('pass');
    expect(result.reasoning).toContain('OpenAI saw the advisory screenshot.');
    expect(result.observations[0]).toMatchObject({
      id: 'openai-dashboard-ok',
      scenarioId: 'dashboard',
      status: 'pass',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sk-test-advisory',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('falls back to OpenAI Chat Completions image input when Responses lacks scope', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-advisory';
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const url = String(_url);
      if (url.endsWith('/responses')) {
        const body = JSON.parse(String(init?.body)) as {
          input: Array<{
            content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
          }>;
        };
        const content = body.input[0]?.content ?? [];
        if (!content.some((part) => part.type === 'input_image')) {
          return new Response(JSON.stringify({ output_text: JSON.stringify({ actions: [] }) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            error: {
              message:
                'You have insufficient permissions for this operation. Missing scopes: api.responses.write.',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }

      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: Array<{
          content: Array<{
            type: string;
            text?: string;
            image_url?: { url: string; detail: string };
          }>;
        }>;
      };
      const content = body.messages[0]?.content ?? [];
      expect(body.model).toBe('gpt-5-mini');
      expect(content.some((part) => part.type === 'text')).toBe(true);
      expect(content).toContainEqual(
        expect.objectContaining({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
            detail: 'high',
          },
        }),
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: 'pass',
                  reasoning: 'Chat Completions saw the advisory screenshot.',
                  observations: [
                    {
                      id: 'openai-chat-dashboard-ok',
                      targetId: 'scenario:dashboard',
                      status: 'pass',
                      summary: 'The dashboard marker is visible in the screenshot.',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-openai-chat-vision',
      task: 'Check dashboard visuals',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      reviewerModel: 'auto',
      reviewerProvider: 'openai',
      hostBrowserRunner: createHostBrowserRunner(
        browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/openai-chat.png')],
          },
        ]),
      ),
      screenshotStore: createScreenshotStore(),
    });

    expect(result.status).toBe('pass');
    expect(result.reasoning).toContain('Chat Completions saw the advisory screenshot.');
    expect(result.observations[0]).toMatchObject({
      id: 'openai-chat-dashboard-ok',
      scenarioId: 'dashboard',
      status: 'pass',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sk-test-advisory',
          'content-type': 'application/json',
        }),
      }),
    );
  });

  it('does not retry OpenAI insufficient quota errors as rate limits', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-advisory';
    const progress: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        input: Array<{
          content: Array<{ type: string }>;
        }>;
      };
      const content = body.input[0]?.content ?? [];
      if (!content.some((part) => part.type === 'input_image')) {
        return new Response(JSON.stringify({ output_text: JSON.stringify({ actions: [] }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: {
            message: 'You exceeded your current quota, please check your plan and billing details.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-openai-quota',
      task: 'Check dashboard visuals',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      reviewerModel: 'auto',
      reviewerProvider: 'openai',
      hostBrowserRunner: createHostBrowserRunner(
        browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/openai-quota.png')],
          },
        ]),
      ),
      screenshotStore: createScreenshotStore(),
      onProgress: (message) => progress.push(message),
    });

    expect(result.status).toBe('uncertain');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress.some((message) => message.includes('waiting'))).toBe(false);
    expect(result.reasoning).toContain('openai_reviewer_http_429');
    expect(result.reasoning).toContain('insufficient_quota');
    expect(result.reasoning).not.toContain('"error"');
    expect(result.observations[0]?.summary).not.toContain('"error"');
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
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Scenario page'],
            screenshotPath: '/tmp/advisory/screenshots/scenario.png',
          },
        ]),
      },
      {
        stdout: browserStdout([
          {
            targetId: 'human_review:visual-state',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Same page for human review'],
            screenshotPath: '/tmp/advisory/screenshots/human-review.png',
          },
        ]),
      },
    ]);
    vi.mocked(hostBrowserRunner.readScreenshot).mockResolvedValue(
      Buffer.from('same-pixels').toString('base64'),
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
      pauseBetweenTargetsMs: 0,
    });

    expect(result.status).toBe('pass');
    expect(result.screenshots).toHaveLength(1);
    expect(screenshotStore.write).toHaveBeenCalledOnce();
  });

  it('attaches a target screenshot to only one observation when reviewer returns many notes', async () => {
    const result = await runAdvisoryBrowserQa({
      podId: 'pod-many-notes',
      task: 'Check dashboard notes',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner: createHostBrowserRunner(
        browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/dashboard.png')],
          },
        ]),
      ),
      screenshotStore: createScreenshotStore(),
      reviewer: {
        review: vi.fn(async () => ({
          status: 'uncertain',
          reasoning: 'Two advisory notes were returned.',
          observations: [
            {
              id: 'first-note',
              targetId: 'scenario:dashboard',
              status: 'uncertain',
              summary: 'First note has the screenshot.',
            },
            {
              id: 'second-note',
              targetId: 'scenario:dashboard',
              status: 'uncertain',
              summary: 'Second note should not repeat the same image.',
            },
          ],
        })),
      },
    });

    expect(result.screenshots).toHaveLength(1);
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]?.screenshots).toHaveLength(1);
    expect(result.observations[1]?.screenshots).toHaveLength(0);
  });

  it('compacts verbose reviewer text before returning advisory results', async () => {
    const longReasoning = Array.from({ length: 30 }, (_, index) => `reason-${index}`).join(' ');
    const longSummary = Array.from({ length: 30 }, (_, index) => `summary-${index}`).join(' ');
    const longDetails = Array.from({ length: 80 }, (_, index) => `detail-${index}`).join(' ');
    const longFacts = Array.from(
      { length: 5 },
      (_, index) =>
        `fact-${index} ${Array.from({ length: 30 }, (__, word) => `word-${word}`).join(' ')}`,
    );

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-verbose-notes',
      task: 'Check dashboard text output',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner: createHostBrowserRunner(
        browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [browserFrame('initial', '/tmp/advisory/screenshots/dashboard.png')],
          },
        ]),
      ),
      screenshotStore: createScreenshotStore(),
      reviewer: {
        review: vi.fn(async () => ({
          status: 'uncertain',
          reasoning: longReasoning,
          observations: [
            {
              id: 'verbose-note',
              targetId: 'scenario:dashboard',
              status: 'uncertain',
              summary: longSummary,
              details: longDetails,
              suggestedFacts: longFacts,
            },
          ],
        })),
      },
    });

    const observation = result.observations[0];
    expect(result.reasoning.length).toBeLessThanOrEqual(360);
    expect(observation?.summary.length).toBeLessThanOrEqual(180);
    expect(observation?.details?.length).toBeLessThanOrEqual(420);
    expect(observation?.suggestedFacts).toHaveLength(3);
    expect(observation?.suggestedFacts?.every((fact) => fact.length <= 180)).toBe(true);
  });

  it('reviews checklist targets sequentially with a pause between targets', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Dashboard visible'],
            screenshotPath: '/tmp/advisory/screenshots/dashboard.png',
          },
        ]),
      },
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:settings',
            url: 'http://127.0.0.1:3000/',
            title: 'Settings',
            notes: ['Settings visible'],
            screenshotPath: '/tmp/advisory/screenshots/settings.png',
          },
        ]),
      },
    ]);
    const reviewedTargets: string[] = [];
    const review = vi.fn(async (input) => {
      const targetId = input.targets[0]?.id ?? '';
      reviewedTargets.push(targetId);
      return {
        status: 'pass' as const,
        reasoning: `${targetId} reviewed`,
        observations: [
          {
            id: `${targetId}-ok`,
            targetId,
            status: 'pass' as const,
            summary: `${targetId} passed.`,
          },
        ],
      };
    });

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-paced',
      task: 'Check two screens',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(
        scenarioOnlyContractYaml(
          `  - id: settings
    given: ["a user has settings"]
    when: ["they open settings"]
    then: ["the settings form is visible"]
`,
          ['dashboard', 'settings'],
        ),
      ),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
      pauseBetweenTargetsMs: 15_000,
      now: () => now,
      sleep,
    });

    expect(result.status).toBe('pass');
    expect(reviewedTargets).toEqual(['scenario:dashboard', 'scenario:settings']);
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(result.observations).toHaveLength(2);
  });

  it('respects retry-after when a target reviewer call is rate-limited', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
        {
          targetId: 'scenario:dashboard',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Dashboard visible'],
          screenshotPath: '/tmp/advisory/screenshots/dashboard.png',
        },
      ]),
    );
    const review = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError('3'))
      .mockResolvedValueOnce({
        status: 'pass' as const,
        reasoning: 'Dashboard reviewed after retry',
        observations: [
          {
            id: 'dashboard-ok',
            targetId: 'scenario:dashboard',
            status: 'pass' as const,
            summary: 'Dashboard passed.',
          },
        ],
      });

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-retry-after',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
      totalBudgetMs: 60_000,
      rateLimitBaseDelayMs: 20_000,
      now: () => now,
      sleep,
    });

    expect(result.status).toBe('pass');
    expect(sleep).toHaveBeenCalledWith(3_000);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('honors retry-after even when it exceeds the configured max delay cap', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
        {
          targetId: 'scenario:dashboard',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Dashboard visible'],
          screenshotPath: '/tmp/advisory/screenshots/dashboard.png',
        },
      ]),
    );
    const review = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError('90'))
      .mockResolvedValueOnce({
        status: 'pass' as const,
        reasoning: 'Dashboard reviewed after long wait',
        observations: [
          {
            id: 'dashboard-ok',
            targetId: 'scenario:dashboard',
            status: 'pass' as const,
            summary: 'Dashboard passed.',
          },
        ],
      });

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-retry-after-uncapped',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
      totalBudgetMs: 240_000,
      rateLimitTargetBudgetMs: 180_000,
      rateLimitBaseDelayMs: 20_000,
      rateLimitMaxDelayMs: 30_000,
      now: () => now,
      sleep,
    });

    expect(result.status).toBe('pass');
    // retry-after was 90s; the old capping logic would have truncated to 30s
    // (rateLimitMaxDelayMs) and retried into the still-active window.
    expect(sleep).toHaveBeenCalledWith(90_000);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('surfaces a 429 immediately when retry-after exceeds the remaining target budget', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
        {
          targetId: 'scenario:dashboard',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Dashboard visible'],
          screenshotPath: '/tmp/advisory/screenshots/dashboard.png',
        },
      ]),
    );
    const review = vi.fn().mockRejectedValue(rateLimitError('600'));
    const progress: string[] = [];

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-retry-after-too-long',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
      onProgress: (message) => progress.push(message),
      totalBudgetMs: 120_000,
      rateLimitTargetBudgetMs: 60_000,
      rateLimitBaseDelayMs: 20_000,
      rateLimitMaxDelayMs: 30_000,
      now: () => now,
      sleep,
    });

    // The reviewer's requested wait (600s) exceeds the per-target budget (60s),
    // so we should give up after the first failed attempt instead of stalling.
    expect(review).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result.status).toBe('uncertain');
    expect(progress.some((message) => message.includes('waiting'))).toBe(false);
  });

  it('does not let slow action planning consume the visual review budget', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
        {
          targetId: 'scenario:dashboard',
          url: 'http://127.0.0.1:3000/',
          title: 'Dashboard',
          notes: ['Dashboard visible'],
          screenshotPath: '/tmp/advisory/screenshots/dashboard.png',
        },
      ]),
    );
    const planActions = vi.fn(() => new Promise<never>(() => {}));
    const review = vi.fn(async () => ({
      status: 'pass' as const,
      reasoning: 'Visual review still ran',
      observations: [
        {
          id: 'dashboard-ok',
          targetId: 'scenario:dashboard',
          status: 'pass' as const,
          summary: 'Dashboard passed.',
        },
      ],
    }));

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-slow-planner',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { planActions, review },
      totalBudgetMs: 60_000,
      actionPlannerBudgetMs: 10_000,
      minReviewAttemptMs: 30_000,
      now: () => now,
      sleep,
    });

    expect(result.status).toBe('pass');
    expect(planActions).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(10_000);
  });

  it('returns partial uncertain evidence when rate limits consume the advisory budget', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Dashboard visible'],
            screenshotPath: '/tmp/advisory/screenshots/dashboard.png',
          },
        ]),
      },
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:settings',
            url: 'http://127.0.0.1:3000/',
            title: 'Settings',
            notes: ['Settings visible'],
            screenshotPath: '/tmp/advisory/screenshots/settings.png',
          },
        ]),
      },
    ]);
    const review = vi.fn(async (input) => {
      const targetId = input.targets[0]?.id;
      if (targetId === 'scenario:settings') throw rateLimitError();
      return {
        status: 'pass' as const,
        reasoning: 'Dashboard reviewed',
        observations: [
          {
            id: 'dashboard-ok',
            targetId,
            status: 'pass' as const,
            summary: 'Dashboard passed.',
          },
        ],
      };
    });
    const progress: string[] = [];

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-partial-rate-limit',
      task: 'Check two screens',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(
        scenarioOnlyContractYaml(
          `  - id: settings
    given: ["a user has settings"]
    when: ["they open settings"]
    then: ["the settings form is visible"]
`,
          ['dashboard', 'settings'],
        ),
      ),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
      onProgress: (message) => progress.push(message),
      totalBudgetMs: 70_000,
      pauseBetweenTargetsMs: 0,
      rateLimitBaseDelayMs: 20_000,
      rateLimitMaxDelayMs: 20_000,
      minReviewAttemptMs: 0,
      now: () => now,
      sleep,
    });

    expect(result.status).toBe('uncertain');
    expect(result.observations.map((observation) => observation.status)).toEqual([
      'pass',
      'uncertain',
    ]);
    expect(result.screenshots).toHaveLength(2);
    expect(progress.some((message) => message.includes('waiting 20s'))).toBe(true);
  });

  it('does not let a rate-limited first target consume the whole advisory run', async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Dashboard visible'],
            screenshotPath: '/tmp/advisory/screenshots/dashboard.png',
          },
        ]),
      },
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:settings',
            url: 'http://127.0.0.1:3000/',
            title: 'Settings',
            notes: ['Settings visible'],
            screenshotPath: '/tmp/advisory/screenshots/settings.png',
          },
        ]),
      },
    ]);
    const reviewedTargets: Array<string | undefined> = [];
    const review = vi.fn(async (input) => {
      const targetId = input.targets[0]?.id;
      reviewedTargets.push(targetId);
      if (targetId === 'scenario:dashboard') throw rateLimitError();
      return {
        status: 'pass' as const,
        reasoning: 'Settings reviewed',
        observations: [
          {
            id: 'settings-ok',
            targetId,
            status: 'pass' as const,
            summary: 'Settings passed.',
          },
        ],
      };
    });

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-first-target-rate-limited',
      task: 'Check two screens',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(
        scenarioOnlyContractYaml(
          `  - id: settings
    given: ["a user has settings"]
    when: ["they open settings"]
    then: ["the settings form is visible"]
`,
          ['dashboard', 'settings'],
        ),
      ),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { review },
      totalBudgetMs: 60_000,
      pauseBetweenTargetsMs: 0,
      rateLimitBaseDelayMs: 20_000,
      rateLimitMaxDelayMs: 20_000,
      rateLimitTargetBudgetMs: 20_000,
      minReviewAttemptMs: 0,
      now: () => now,
      sleep,
    });

    expect(result.status).toBe('uncertain');
    expect(result.observations.map((observation) => observation.status)).toEqual([
      'uncertain',
      'pass',
    ]);
    expect(result.screenshots).toHaveLength(2);
    expect(reviewedTargets).toEqual([
      'scenario:dashboard',
      'scenario:dashboard',
      'scenario:settings',
    ]);
    expect(result.reasoning).toContain('reviewed 2/2 checklist targets');
  });

  it('ignores browser observations outside the current checklist targets', async () => {
    const review = vi.fn(async (input) => {
      expect(input.browserObservations.map((observation) => observation.targetId)).toEqual([
        'scenario:dashboard',
      ]);
      return {
        status: 'pass' as const,
        reasoning: 'Current target only',
        observations: [
          {
            id: 'dashboard-current',
            targetId: 'scenario:dashboard',
            status: 'pass' as const,
            summary: 'Current dashboard evidence reviewed.',
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
            notes: ['Current checklist target'],
            screenshotPath: '/tmp/advisory/screenshots/current.png',
          },
          {
            targetId: 'scenario:old-pod',
            url: 'http://127.0.0.1:3000/',
            title: 'Old pod',
            notes: ['Stale target from a different contract'],
            screenshotPath: '/tmp/advisory/screenshots/stale.png',
          },
        ]),
      },
    ]);
    const screenshotStore = createScreenshotStore();

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-current-only',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore,
      reviewer: { review },
    });

    expect(result.status).toBe('pass');
    expect(result.screenshots).toHaveLength(1);
    expect(result.screenshots[0]?.relativePath).toBe(
      'screenshots/pod-current-only/advisory/advisory-0.png',
    );
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
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: { planActions, review },
    });

    expect(result.status).toBe('pass');
    expect(hostBrowserRunner.runScript).toHaveBeenCalledTimes(2);
    expect(result.screenshots).toHaveLength(2);
  });

  it('ignores reviewer-planned actions outside the current checklist targets', async () => {
    const hostBrowserRunner = createSequentialHostBrowserRunner([
      {
        stdout: browserStdout([
          {
            targetId: 'scenario:dashboard',
            url: 'http://127.0.0.1:3000/',
            title: 'Dashboard',
            notes: ['Reached page'],
            frames: [
              browserFrame('initial', '/tmp/advisory/screenshots/initial.png', [
                {
                  index: 0,
                  role: 'button',
                  tag: 'button',
                  text: 'Open details',
                  ariaLabel: 'Open details',
                  title: '',
                  disabled: false,
                  visible: true,
                  rect: { x: 10, y: 20, width: 120, height: 30 },
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
              browserFrame('initial', '/tmp/advisory/screenshots/action-initial.png'),
              browserFrame('after-action-1', '/tmp/advisory/screenshots/action-after.png', [], {
                status: 'pass',
                action: { type: 'click', controlIndex: 0, reason: 'Open details' },
                summary: 'Clicked control',
              }),
            ],
          },
        ]),
      },
    ]);
    const planActions = vi.fn(async () => [
      {
        targetId: 'scenario:old-pod',
        actions: [{ type: 'click' as const, controlIndex: 99, reason: 'Stale action' }],
      },
      {
        targetId: 'scenario:dashboard',
        actions: [{ type: 'click' as const, controlIndex: 0, reason: 'Open details' }],
      },
    ]);

    await runAdvisoryBrowserQa({
      podId: 'pod-actions-current-only',
      task: 'Check dashboard controls',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: {
        planActions,
        review: vi.fn(async () => ({
          status: 'pass',
          reasoning: 'Current action reviewed',
          observations: [],
        })),
      },
    });

    const actionScript = vi.mocked(hostBrowserRunner.runScript).mock.calls[1]?.[0] as string;
    expect(hostBrowserRunner.runScript).toHaveBeenCalledTimes(2);
    expect(actionScript).toContain('"scenario:dashboard"');
    expect(actionScript).not.toContain('scenario:old-pod');
  });

  it('does not auto-click visible help controls without a reviewer action plan', async () => {
    const hostBrowserRunner = createHostBrowserRunner(
      browserStdout([
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
    );

    const planActions = vi.fn(async () => []);
    const review = vi.fn(async (input) => {
      expect(input.browserObservations[0]?.frames).toHaveLength(1);
      expect(input.browserObservations[0]?.frames[0]?.action).toBeUndefined();
      return {
        status: 'pass' as const,
        reasoning: 'Help control was left closed unless explicitly planned.',
        observations: [],
      };
    });

    await runAdvisoryBrowserQa({
      podId: 'pod-help',
      task: 'Add a how-to-use help modal triggered from a new ? icon button',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: {
        planActions,
        review,
      },
    });

    expect(hostBrowserRunner.runScript).toHaveBeenCalledTimes(1);
    expect(planActions).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
  });

  it('ignores reviewer observations outside the current checklist targets', async () => {
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

    const result = await runAdvisoryBrowserQa({
      podId: 'pod-review-current-only',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner,
      screenshotStore: createScreenshotStore(),
      reviewer: {
        review: vi.fn(async () => ({
          status: 'pass',
          reasoning: 'Only current observations should survive',
          observations: [
            {
              id: 'dashboard-current',
              targetId: 'scenario:dashboard',
              status: 'pass',
              summary: 'Current target reviewed.',
            },
            {
              id: 'old-target',
              targetId: 'scenario:old-pod',
              status: 'fail',
              summary: 'Stale target should be ignored.',
            },
            {
              id: 'missing-target',
              status: 'uncertain',
              summary: 'Targetless observation should be ignored.',
            },
          ],
        })),
      },
    });

    expect(result.observations.map((observation) => observation.id)).toEqual(['dashboard-current']);
  });

  it('returns uncertain advisory evidence when browser execution errors', async () => {
    const result = await runAdvisoryBrowserQa({
      podId: 'pod-3',
      task: 'Check dashboard',
      baseUrl: 'http://127.0.0.1:3000',
      contract: parseSpecContract(scenarioOnlyContractYaml()),
      hostBrowserRunner: createHostBrowserRunner('not json', 1),
      screenshotStore: createScreenshotStore(),
      reviewer: { review: vi.fn() },
    });

    expect(result.status).toBe('uncertain');
    expect(result.reasoning).toContain('script failed');
    expect(result.observations).toMatchObject([
      {
        scenarioId: 'dashboard',
        status: 'uncertain',
        summary: 'Advisory browser QA script failed for dashboard.',
      },
    ]);
  });
});
