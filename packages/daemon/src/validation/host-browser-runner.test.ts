import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostBrowserRunner, resolvePlaywrightCwdFromEntry } from './host-browser-runner.js';

const logger = pino({ level: 'silent' });

describe('HostBrowserRunner', () => {
  const runner = createHostBrowserRunner(logger);
  const testSessionId = 'test-pod-hbr';

  afterEach(async () => {
    await runner.cleanup(testSessionId);
  });

  describe('getAvailability', () => {
    it('uses the innermost node_modules parent for pnpm Playwright paths', () => {
      expect(
        resolvePlaywrightCwdFromEntry(
          '/repo/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright/index.js',
        ),
      ).toBe('/repo/node_modules/.pnpm/playwright@1.59.1');
    });

    it('uses the package parent for hoisted Playwright paths', () => {
      expect(
        resolvePlaywrightCwdFromEntry('/repo/packages/daemon/node_modules/playwright/index.js'),
      ).toBe('/repo/packages/daemon');
    });

    it('caches successful availability probes', async () => {
      const probeAvailability = vi.fn(async () => ({
        available: true,
        reason: 'ok',
        playwrightPackagePath: '/repo/node_modules/playwright/index.js',
        playwrightCwd: '/repo',
        chromiumExecutablePath: '/chrome',
      }));
      const diagnosticRunner = createHostBrowserRunner(logger, { probeAvailability });

      const first = await diagnosticRunner.getAvailability();
      const second = await diagnosticRunner.getAvailability();

      expect(first.available).toBe(true);
      expect(first.cached).toBe(false);
      expect(second.available).toBe(true);
      expect(second.cached).toBe(true);
      expect(probeAvailability).toHaveBeenCalledTimes(1);
    });

    it('retries failed availability probes instead of caching unavailable forever', async () => {
      const probeAvailability = vi
        .fn()
        .mockResolvedValueOnce({
          available: false,
          reason: 'chromium missing',
          playwrightPackagePath: '/repo/node_modules/playwright/index.js',
          playwrightCwd: '/repo',
          chromiumExecutablePath: null,
          exitCode: 1,
          stderr: 'missing executable',
        })
        .mockResolvedValueOnce({
          available: true,
          reason: 'ok now',
          playwrightPackagePath: '/repo/node_modules/playwright/index.js',
          playwrightCwd: '/repo',
          chromiumExecutablePath: '/chrome',
        });
      const diagnosticRunner = createHostBrowserRunner(logger, { probeAvailability });

      const first = await diagnosticRunner.getAvailability();
      const second = await diagnosticRunner.getAvailability();

      expect(first.available).toBe(false);
      expect(first.cached).toBe(false);
      expect(first.reason).toBe('chromium missing');
      expect(second.available).toBe(true);
      expect(second.cached).toBe(false);
      expect(second.chromiumExecutablePath).toBe('/chrome');
      expect(probeAvailability).toHaveBeenCalledTimes(2);
    });
  });

  describe('runScript', () => {
    it('executes a script and returns stdout', async () => {
      const script = `console.log('hello from host');`;
      const result = await runner.runScript(script, {
        timeout: 10_000,
        podId: testSessionId,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello from host');
    });

    it('captures stderr', async () => {
      const script = `console.error('oops');`;
      const result = await runner.runScript(script, {
        timeout: 10_000,
        podId: testSessionId,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('oops');
    });

    it('returns non-zero exit code on script error', async () => {
      const script = 'process.exit(1);';
      const result = await runner.runScript(script, {
        timeout: 10_000,
        podId: testSessionId,
      });

      expect(result.exitCode).toBe(1);
    });

    it('rejects on timeout', async () => {
      const script = 'await new Promise(r => setTimeout(r, 30000));';
      await expect(
        runner.runScript(script, { timeout: 500, podId: testSessionId }),
      ).rejects.toThrow('timed out');
    });
  });

  describe('screenshotDir', () => {
    it('returns a pod-scoped directory under os.tmpdir()', () => {
      const dir = runner.screenshotDir('my-pod');
      expect(dir).toContain('autopod-browser');
      expect(dir).toContain('my-pod');
      expect(dir).toContain('screenshots');
    });

    it('returns different dirs for different pods', () => {
      expect(runner.screenshotDir('a')).not.toBe(runner.screenshotDir('b'));
    });
  });

  describe('readScreenshot', () => {
    it('reads a file and returns base64', async () => {
      const dir = runner.screenshotDir(testSessionId);
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, 'test.png');
      await writeFile(filePath, 'fake-png-data');

      const b64 = await runner.readScreenshot(filePath);
      expect(b64).toBe(Buffer.from('fake-png-data').toString('base64'));
    });

    it('throws on missing file', async () => {
      await expect(runner.readScreenshot('/nonexistent/file.png')).rejects.toThrow();
    });
  });

  describe('cleanup', () => {
    it('removes the pod temp directory', async () => {
      const dir = runner.screenshotDir(testSessionId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'test.txt'), 'data');

      await runner.cleanup(testSessionId);

      // Directory should be gone — readScreenshot should fail
      await expect(runner.readScreenshot(join(dir, 'test.txt'))).rejects.toThrow();
    });

    it('does not throw if directory does not exist', async () => {
      await expect(runner.cleanup('nonexistent-pod')).resolves.not.toThrow();
    });
  });
});
