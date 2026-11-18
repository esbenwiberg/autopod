import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import {
  directNodeTest,
  prepareTestMemory,
  requireMemoryImprovement,
} from './test-process-memory.js';

const exec = promisify(execFile);
describe('command-specific prospective test memory evidence', () => {
  it('measures command-local and CLI heap precedence and correlates the actual single test process', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'memory-proof-'));
    const files: string[] = [];
    try {
      await writeFile(
        path.join(root, 'test.cjs'),
        "require('node:test')('unchanged assertion',()=>require('node:assert/strict').equal(1,1));\n",
      );
      const cm = createMockContainerManager();
      cm.getExecutionMetadata = vi.fn(async () => ({
        podId: 'fixture',
        imageDigest: 'sha256:fixture',
        memoryLimitBytes: 8 * 1024 ** 3,
        cpuLimit: 1,
        networkMode: 'none',
      }));
      cm.getResourceKey = vi.fn(async () => 'docker:fixture:exact');
      cm.writeFile = vi.fn(async (_id, file, content) => {
        files.push(file);
        await writeFile(file, content);
      });
      cm.execInContainer = vi.fn(async (_id, command) => {
        const [program, ...args] = command;
        const result = await exec(program!, args, {
          cwd: root,
          env: { PATH: process.env.PATH, NODE_OPTIONS: '--max-old-space-size=32' },
        });
        return { ...result, exitCode: 0 };
      });
      const config = {
        podId: 'fixture',
        containerId: 'exact',
        executionTarget: 'local',
        testCommand:
          "NODE_OPTIONS='--max-old-space-size=64' node --max-old-space-size=96 --test --experimental-test-isolation=none test.cjs",
      } as ValidationEngineConfig;
      const prepared = await prepareTestMemory(cm, config);
      expect(prepared).toBeDefined();
      expect(prepared!.evidence.heapLimitBytes).toBeGreaterThan(96 * 1024 ** 2);
      expect(prepared!.evidence.heapLimitBytes).toBeLessThan(160 * 1024 ** 2);
      const actual = await cm.execInContainer('exact', ['sh', '-c', prepared!.command]);
      const output = actual.stdout + '\n' + actual.stderr;
      const evidence = prepared!.actual(output, false)!;
      expect(evidence.processId).toBeGreaterThan(0);
      expect(evidence.processId).not.toBe(prepared!.evidence.processId);
      expect(
        prepared!.actual(
          output +
            '\n<--- Last few GCs --->\n[999999:isolate] GC\n<--- JS stacktrace --->\nFATAL ERROR: JavaScript heap out of memory',
          true,
        ),
      ).toBeUndefined();
      expect(
        prepared!.actual(
          output +
            `\n<--- Last few GCs --->\n[${evidence.processId}:isolate] GC\n<--- JS stacktrace --->\nFATAL ERROR: JavaScript heap out of memory`,
          true,
        ),
      ).toEqual(evidence);
      expect(() => requireMemoryImprovement(evidence, evidence)).toThrow('improvement');
      expect(() =>
        requireMemoryImprovement(evidence, {
          ...evidence,
          heapLimitBytes: evidence.heapLimitBytes + 1024,
        }),
      ).not.toThrow();
      expect(() => requireMemoryImprovement(undefined, evidence)).toThrow('unverified');
    } finally {
      for (const file of files) await rm(file, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    'pnpm test',
    'NODE_OPTIONS="--require=untrusted" node --test test.js',
    'node --max-old-space-size=2048 --test tests.js',
    'node --test --test-isolation=none tests.js; other',
    'node --test --test-isolation=none $(other)',
    'node --require=hook --test --test-isolation=none tests.js',
  ])('does not qualify opaque or changing process commands: %s', (command) => {
    expect(directNodeTest(command)).toBeNull();
  });
});
