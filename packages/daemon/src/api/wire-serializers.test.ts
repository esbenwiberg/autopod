import type { Pod, ScreenshotRef, TaskReviewResult, ValidationResult } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  serializePodForWire,
  serializeSystemEventForWire,
  serializeValidationResult,
  toScreenshotRefDto,
} from './wire-serializers.js';

const ref = (overrides?: Partial<ScreenshotRef>): ScreenshotRef => ({
  podId: 'pod-12345',
  source: 'smoke',
  filename: 'root.png',
  relativePath: 'screenshots/pod-12345/smoke/root.png',
  ...overrides,
});

const baseValidation = (): ValidationResult => ({
  podId: 'pod-12345',
  attempt: 1,
  timestamp: '2026-05-10T00:00:00Z',
  smoke: {
    status: 'pass',
    build: { status: 'pass', output: '', duration: 0 },
    health: { status: 'pass', url: 'http://localhost', responseCode: 200, duration: 0 },
    pages: [
      {
        path: '/',
        status: 'pass',
        screenshotPath: 'screenshots/pod-12345/smoke/root.png',
        screenshot: ref(),
        consoleErrors: [],
        assertions: [],
        loadTime: 100,
      },
    ],
  },
  taskReview: null,
  overall: 'pass',
  duration: 1000,
});

describe('toScreenshotRefDto', () => {
  it('maps a ScreenshotRef into the DTO shape with a relative URL', () => {
    expect(toScreenshotRefDto(ref(), '/dashboard')).toEqual({
      url: '/pods/pod-12345/screenshots/smoke/root.png',
      source: 'smoke',
      path: '/dashboard',
    });
  });
});

describe('serializeValidationResult', () => {
  it('rewrites smoke page screenshots to DTO shape', () => {
    const out = serializeValidationResult(baseValidation()) as {
      smoke: { pages: Array<{ screenshot?: { url: string; source: string; path: string } }> };
    };
    const screenshot = out.smoke.pages[0]?.screenshot;
    expect(screenshot).toEqual({
      url: '/pods/pod-12345/screenshots/smoke/root.png',
      source: 'smoke',
      path: '/',
    });
    // No internal-only fields leak through.
    expect(screenshot).not.toHaveProperty('podId');
    expect(screenshot).not.toHaveProperty('relativePath');
    expect(screenshot).not.toHaveProperty('filename');
  });

  it('passes pages without a screenshot through unchanged', () => {
    const v = baseValidation();
    if (v.smoke.pages[0]) v.smoke.pages[0].screenshot = undefined;
    const out = serializeValidationResult(v) as {
      smoke: { pages: Array<{ screenshot?: unknown }> };
    };
    expect(out.smoke.pages[0]?.screenshot).toBeUndefined();
  });

  it('rewrites task-review screenshots and labels them with their context', () => {
    const review: TaskReviewResult = {
      status: 'pass',
      reasoning: 'looks good',
      issues: [],
      model: 'claude',
      screenshots: [ref({ source: 'review', filename: '0.png' })],
      diff: '',
    };
    const v = { ...baseValidation(), taskReview: review };
    const out = serializeValidationResult(v) as {
      taskReview: { screenshots: Array<{ path: string; url: string }> };
    };
    expect(out.taskReview.screenshots[0]).toEqual({
      url: '/pods/pod-12345/screenshots/review/0.png',
      source: 'review',
      path: '0',
    });
  });

  it('rewrites fact screenshot attachments and labels them with attachment context', () => {
    const v: ValidationResult = {
      ...baseValidation(),
      factValidation: {
        status: 'pass',
        results: [
          {
            factId: 'fact-page',
            proves: ['page'],
            kind: 'browser-test',
            artifactPath: 'src/page.test.ts',
            command: 'node fact.mjs',
            passed: true,
            reasoning: 'Fact passed.',
            attachments: [
              {
                kind: 'screenshot',
                path: '.autopod/evidence/fact-page/screenshot.png',
                label: 'Rendered page',
                screenshot: ref({ source: 'fact', filename: 'fact-page-0-screenshot.png' }),
              },
            ],
          },
        ],
      },
    };
    const out = serializeValidationResult(v) as {
      factValidation: {
        results: Array<{ attachments?: Array<{ screenshot?: { url: string; source: string } }> }>;
      };
    };
    expect(out.factValidation.results[0]?.attachments?.[0]?.screenshot).toEqual({
      url: '/pods/pod-12345/screenshots/fact/fact-page-0-screenshot.png',
      source: 'fact',
      path: 'Rendered page',
    });
  });

  it('rewrites advisory browser QA screenshots', () => {
    const advisoryRef = ref({ source: 'advisory', filename: 'obs.png' });
    const v: ValidationResult = {
      ...baseValidation(),
      advisoryBrowserQa: {
        status: 'uncertain',
        reasoning: 'Advisory pass recorded.',
        observations: [
          {
            id: 'obs-1',
            status: 'uncertain',
            summary: 'Visual check',
            screenshots: [advisoryRef],
          },
        ],
        screenshots: [advisoryRef],
      },
    };

    const out = serializeValidationResult(v) as {
      advisoryBrowserQa: {
        observations: Array<{ screenshots: Array<{ url: string; source: string; path: string }> }>;
        screenshots: Array<{ url: string; source: string; path: string }>;
      };
    };

    expect(out.advisoryBrowserQa.screenshots[0]).toEqual({
      url: '/pods/pod-12345/screenshots/advisory/obs.png',
      source: 'advisory',
      path: '0',
    });
    expect(out.advisoryBrowserQa.observations[0]?.screenshots[0]).toEqual({
      url: '/pods/pod-12345/screenshots/advisory/obs.png',
      source: 'advisory',
      path: 'obs-1:0',
    });
  });
});

describe('serializePodForWire', () => {
  it('returns the pod unchanged when there is no validation result', () => {
    const pod = { id: 'p1', lastValidationResult: null } as unknown as Pod;
    expect(serializePodForWire(pod)).toBe(pod);
  });

  it('rewrites lastValidationResult.smoke.pages[].screenshot to DTO shape', () => {
    const pod = { id: 'p1', lastValidationResult: baseValidation() } as unknown as Pod;
    const out = serializePodForWire(pod) as {
      lastValidationResult: {
        smoke: { pages: Array<{ screenshot?: { url: string } }> };
      };
    };
    expect(out.lastValidationResult.smoke.pages[0]?.screenshot?.url).toBe(
      '/pods/pod-12345/screenshots/smoke/root.png',
    );
  });
});

describe('serializeSystemEventForWire', () => {
  it('rewrites screenshots inside pod.validation_completed', () => {
    const out = serializeSystemEventForWire({
      type: 'pod.validation_completed',
      timestamp: '2026-05-10T00:00:00Z',
      podId: 'pod-12345',
      result: baseValidation(),
    }) as {
      type: string;
      result: { smoke: { pages: Array<{ screenshot?: { url: string } }> } };
    };
    expect(out.type).toBe('pod.validation_completed');
    expect(out.result.smoke.pages[0]?.screenshot?.url).toBe(
      '/pods/pod-12345/screenshots/smoke/root.png',
    );
  });

  it('rewrites advisory screenshot refs inside pod.validation_completed', () => {
    const advisoryRef = ref({ source: 'advisory', filename: 'concern.png' });
    const result: ValidationResult = {
      ...baseValidation(),
      advisoryBrowserQa: {
        status: 'fail',
        reasoning: 'Visual concern found.',
        observations: [
          {
            id: 'advisory-concern-nonblocking',
            status: 'fail',
            summary: 'Loaded data is overlapped by an empty state.',
            screenshots: [advisoryRef],
            suggestedFacts: ['Add a browser fact for the loaded dashboard state.'],
          },
        ],
        screenshots: [advisoryRef],
      },
    };

    const out = serializeSystemEventForWire({
      type: 'pod.validation_completed',
      timestamp: '2026-05-10T00:00:00Z',
      podId: 'pod-12345',
      result,
    }) as {
      result: {
        advisoryBrowserQa?: {
          observations: Array<{
            screenshots: Array<{ url: string; source: string; path: string }>;
          }>;
          screenshots: Array<{ url: string; source: string; path: string }>;
        } | null;
      };
    };

    expect(out.result.advisoryBrowserQa?.screenshots[0]).toEqual({
      url: '/pods/pod-12345/screenshots/advisory/concern.png',
      source: 'advisory',
      path: '0',
    });
    expect(out.result.advisoryBrowserQa?.observations[0]?.screenshots[0]).toEqual({
      url: '/pods/pod-12345/screenshots/advisory/concern.png',
      source: 'advisory',
      path: 'advisory-concern-nonblocking:0',
    });
  });

  it('rewrites pageResults inside pod.validation_phase_completed (pages phase)', () => {
    const v = baseValidation();
    const out = serializeSystemEventForWire({
      type: 'pod.validation_phase_completed',
      timestamp: '2026-05-10T00:00:00Z',
      podId: 'pod-12345',
      phase: 'pages',
      phaseStatus: 'pass',
      pageResults: v.smoke.pages,
    }) as { pageResults?: Array<{ screenshot?: { url: string } }> };
    expect(out.pageResults?.[0]?.screenshot?.url).toBe(
      '/pods/pod-12345/screenshots/smoke/root.png',
    );
  });

  it('rewrites advisory screenshot refs inside pod.validation_phase_completed', () => {
    const advisoryRef = ref({ source: 'advisory', filename: 'concern.png' });
    const out = serializeSystemEventForWire({
      type: 'pod.validation_phase_completed',
      timestamp: '2026-05-10T00:00:00Z',
      podId: 'pod-12345',
      phase: 'advisory',
      phaseStatus: 'fail',
      advisoryResult: {
        status: 'fail',
        reasoning: 'Visual concern found.',
        observations: [
          {
            id: 'advisory-concern-nonblocking',
            status: 'fail',
            summary: 'Loaded data is overlapped by an empty state.',
            screenshots: [advisoryRef],
            suggestedFacts: ['Add a browser fact for the loaded dashboard state.'],
          },
        ],
        screenshots: [advisoryRef],
      },
    }) as {
      advisoryResult?: {
        observations: Array<{
          screenshots: Array<{ url: string; source: string; path: string }>;
        }>;
        screenshots: Array<{ url: string; source: string; path: string }>;
      } | null;
    };

    expect(out.advisoryResult?.screenshots[0]).toEqual({
      url: '/pods/pod-12345/screenshots/advisory/concern.png',
      source: 'advisory',
      path: '0',
    });
    expect(out.advisoryResult?.observations[0]?.screenshots[0]).toEqual({
      url: '/pods/pod-12345/screenshots/advisory/concern.png',
      source: 'advisory',
      path: 'advisory-concern-nonblocking:0',
    });
  });

  it('returns non-validation events unchanged', () => {
    const event = {
      type: 'pod.status_changed' as const,
      timestamp: '2026-05-10T00:00:00Z',
      podId: 'pod-12345',
      previousStatus: 'queued' as const,
      newStatus: 'running' as const,
    };
    expect(serializeSystemEventForWire(event)).toBe(event);
  });
});
