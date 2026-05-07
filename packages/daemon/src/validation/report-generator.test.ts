import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ScreenshotRef, ValidationResult } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import { createScreenshotStore } from '../pods/screenshot-store.js';
import { generateValidationReport } from './report-generator.js';

const logger = pino({ level: 'silent' });

function makeMockStore(overrides?: Partial<ScreenshotStore>): ScreenshotStore {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeBaseResult(overrides?: Partial<ValidationResult>): ValidationResult {
  return {
    podId: 'pod-abc',
    attempt: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 100 },
      health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 50 },
      pages: [],
    },
    taskReview: null,
    overall: 'pass',
    duration: 150,
    ...overrides,
  };
}

const SMOKE_REF: ScreenshotRef = {
  podId: 'pod-abc',
  source: 'smoke',
  filename: '0-root.png',
  relativePath: 'screenshots/pod-abc/smoke/0-root.png',
};

describe('generateValidationReport', () => {
  let tmpDir: string;
  let screenshotStore: ScreenshotStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'report-test-'));
    screenshotStore = createScreenshotStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generates an HTML report with no screenshots when pages array is empty', async () => {
    const result = makeBaseResult();
    const html = await generateValidationReport(result, { screenshotStore, logger });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('pod-abc');
    expect(html).toContain('PASS');
    expect(html).not.toContain('<img');
  });

  it('embeds a screenshot as a base64 data URL', async () => {
    const pngBytes = Buffer.from('PNGBYTES');
    await screenshotStore.write('pod-abc', 'smoke', '0-root.png', pngBytes);

    const result = makeBaseResult({
      smoke: {
        status: 'pass',
        build: { status: 'pass', output: '', duration: 100 },
        health: { status: 'pass', url: 'http://localhost:3000', responseCode: 200, duration: 50 },
        pages: [
          {
            path: '/',
            status: 'pass',
            screenshotPath: '',
            screenshot: SMOKE_REF,
            consoleErrors: [],
            assertions: [],
            loadTime: 100,
          },
        ],
      },
    });

    const html = await generateValidationReport(result, { screenshotStore, logger });

    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain(pngBytes.toString('base64'));
    expect(html).toContain('<img');
  });

  describe('fail-soft on missing file', () => {
    it('skips missing smoke screenshot and still generates the report', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const result = makeBaseResult({
        smoke: {
          status: 'pass',
          build: { status: 'pass', output: '', duration: 100 },
          health: {
            status: 'pass',
            url: 'http://localhost:3000',
            responseCode: 200,
            duration: 50,
          },
          pages: [
            {
              path: '/',
              status: 'pass',
              screenshotPath: '',
              screenshot: SMOKE_REF, // file was never written to the store
              consoleErrors: [],
              assertions: [],
              loadTime: 100,
            },
          ],
        },
      });

      const html = await generateValidationReport(result, { screenshotStore, logger });

      // Report still renders
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('pod-abc');
      // No broken <img> tag
      expect(html).not.toContain('<img');
      // Warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filename: '0-root.png' }),
        expect.stringContaining('missing'),
      );
    });

    it('skips a missing screenshot from a mock store and warns', async () => {
      const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const mockStore = makeMockStore({
        read: vi.fn().mockRejectedValue(enoentErr),
      });
      const warnSpy = vi.spyOn(logger, 'warn');

      const result = makeBaseResult({
        smoke: {
          status: 'pass',
          build: { status: 'pass', output: '', duration: 100 },
          health: {
            status: 'pass',
            url: 'http://localhost:3000',
            responseCode: 200,
            duration: 50,
          },
          pages: [
            {
              path: '/about',
              status: 'pass',
              screenshotPath: '',
              screenshot: SMOKE_REF,
              consoleErrors: [],
              assertions: [],
              loadTime: 200,
            },
          ],
        },
      });

      const html = await generateValidationReport(result, { screenshotStore: mockStore, logger });

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).not.toContain('<img');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('generates report without a store (no screenshots attempted)', async () => {
      const result = makeBaseResult({
        smoke: {
          status: 'pass',
          build: { status: 'pass', output: '', duration: 100 },
          health: {
            status: 'pass',
            url: 'http://localhost:3000',
            responseCode: 200,
            duration: 50,
          },
          pages: [
            {
              path: '/',
              status: 'pass',
              screenshotPath: '',
              screenshot: SMOKE_REF,
              consoleErrors: [],
              assertions: [],
              loadTime: 100,
            },
          ],
        },
      });

      // Pass no screenshotStore — report must still succeed
      const html = await generateValidationReport(result, { logger });

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).not.toContain('<img');
    });
  });
});
