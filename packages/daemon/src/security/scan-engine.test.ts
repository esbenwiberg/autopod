import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScanFinding, SecurityScanPolicy } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Detector } from './detectors/detector.js';
import { createScanEngine } from './scan-engine.js';
import { getPreset } from './scan-policy.js';

const logger = pino({ level: 'silent' });

function fakeDetector(
  name: 'secrets' | 'pii' | 'injection',
  findings: (file: string) => ScanFinding[],
): Detector {
  return {
    name,
    async warmup() {},
    async scan(file) {
      return findings(file.path);
    },
  };
}

describe('scan-engine', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(os.tmpdir(), 'autopod-eng-'));
    execSync('git init -q', { cwd: workdir });
    execSync('git config user.email t@e.x', { cwd: workdir });
    execSync('git config user.name test', { cwd: workdir });
    execSync('git config commit.gpgsign false', { cwd: workdir });
    writeFileSync(path.join(workdir, 'CLAUDE.md'), 'instructions');
    writeFileSync(path.join(workdir, 'src.ts'), 'const x = 1;');
    execSync('git add -A', { cwd: workdir });
    execSync('git commit -q -m initial', { cwd: workdir });
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('produces pass when no detectors are enabled', async () => {
    const policy: SecurityScanPolicy = getPreset('default');
    policy.detectors.secrets.enabled = false;
    const engine = createScanEngine({ detectors: [], logger });
    const result = await engine.run({
      podId: 'p1',
      workdir,
      policy,
      checkpoint: 'provisioning',
    });
    expect(result.decision).toBe('pass');
  });

  it('runs the secrets detector on the always-scan list at provisioning', async () => {
    const seen: string[] = [];
    const detector = fakeDetector('secrets', (file) => {
      seen.push(file);
      if (file === 'CLAUDE.md') {
        return [
          {
            detector: 'secrets',
            severity: 'critical',
            file,
            line: 1,
            snippet: '[REDACTED]',
          },
        ];
      }
      return [];
    });
    const engine = createScanEngine({ detectors: [detector], logger });
    const policy = getPreset('default');
    const result = await engine.run({
      podId: 'p2',
      workdir,
      policy,
      checkpoint: 'provisioning',
    });
    expect(seen).toContain('CLAUDE.md');
    expect(result.findings).toHaveLength(1);
    expect(result.decision).toBe('warn');
    expect(result.warningSection?.heading).toBe('Security Notice');
  });

  it('blocks when policy says so', async () => {
    const detector = fakeDetector('secrets', () => [
      {
        detector: 'secrets',
        severity: 'critical',
        file: 'src.ts',
        snippet: '[REDACTED]',
      },
    ]);
    const engine = createScanEngine({ detectors: [detector], logger });
    const policy = getPreset('default');
    policy.provisioning.onSecret = 'block';
    const result = await engine.run({
      podId: 'p3',
      workdir,
      policy,
      checkpoint: 'provisioning',
    });
    expect(result.decision).toBe('block');
  });

  it('rewrites push block→escalate for workspace pods', async () => {
    const detector = fakeDetector('secrets', () => [
      {
        detector: 'secrets',
        severity: 'critical',
        file: 'src.ts',
        snippet: '[REDACTED]',
      },
    ]);
    const engine = createScanEngine({ detectors: [detector], logger });
    const policy = getPreset('default');
    // Push checkpoint defaults to scope=diff; flip to full so the test
    // doesn't need a baseRef.
    policy.push.scope = 'full';
    const result = await engine.run({
      podId: 'p4',
      workdir,
      policy,
      checkpoint: 'push',
      isWorkspacePod: true,
    });
    expect(result.decision).toBe('escalate');
  });

  it('drops ML findings below threshold', async () => {
    const detector = fakeDetector('injection', () => [
      {
        detector: 'injection',
        severity: 'medium',
        file: 'CLAUDE.md',
        confidence: 0.5, // below default 0.8 threshold
        snippet: 'maybe injection?',
      },
    ]);
    const engine = createScanEngine({ detectors: [detector], logger });
    const policy = getPreset('default');
    policy.detectors.injection.enabled = true;
    const result = await engine.run({
      podId: 'p5',
      workdir,
      policy,
      checkpoint: 'provisioning',
    });
    expect(result.findings).toHaveLength(0);
    expect(result.decision).toBe('pass');
  });

  it('survives a detector that throws', async () => {
    const throwing: Detector = {
      name: 'secrets',
      async warmup() {},
      async scan() {
        throw new Error('boom');
      },
    };
    const engine = createScanEngine({ detectors: [throwing], logger });
    const policy = getPreset('default');
    const result = await engine.run({
      podId: 'p6',
      workdir,
      policy,
      checkpoint: 'provisioning',
    });
    expect(result.findings).toHaveLength(0);
    expect(result.decision).toBe('pass');
  });
});
