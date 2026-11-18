import { createHash, randomUUID } from 'node:crypto';
import type { TestProcessMemoryEvidence } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ValidationEngineConfig } from '../interfaces/validation-engine.js';
import { wrapValidationExecCommand } from '../pods/registry-injector.js';
import { TaskRetryBlockedError } from '../pods/task-retry-ledger.js';

export const memoryCommandHash = (command: string) =>
  createHash('sha256').update(command).digest('hex');

/** Intentionally bounded grammar. Package scripts, shells, preload hooks and child
 * test workers cannot be qualified by probing an unrelated `node -e` process.
 * Keep those honestly unavailable until their actual process contract is supported.
 */
export function directNodeTest(command: string) {
  const match =
    /^(?:(NODE_OPTIONS=(?:'--max-old-space-size=\d+'|"--max-old-space-size=\d+")) )?(node(?: --max-old-space-size=\d+)?) --test --(?:experimental-)?test-isolation=none( [A-Za-z0-9_./][A-Za-z0-9_./-]*)+$/.exec(
      command,
    );
  return match
    ? {
        prefix: `${match[1] ? `${match[1]} ` : ''}${match[2]}`,
        assignment: match[1],
        node: match[2],
        tests: command.slice(command.indexOf(' --test')),
      }
    : null;
}

export function requireMemoryImprovement(
  prior: TestProcessMemoryEvidence | undefined,
  candidate: TestProcessMemoryEvidence | undefined,
) {
  if (
    !prior ||
    !candidate ||
    prior.version !== 1 ||
    candidate.version !== 1 ||
    prior.kind !== 'node-heap' ||
    candidate.kind !== 'node-heap' ||
    prior.commandHash !== candidate.commandHash ||
    ![
      prior.heapLimitBytes,
      prior.containerLimitBytes,
      candidate.heapLimitBytes,
      candidate.containerLimitBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    candidate.heapLimitBytes <= prior.heapLimitBytes ||
    candidate.containerLimitBytes < prior.containerLimitBytes ||
    candidate.heapLimitBytes >= candidate.containerLimitBytes
  ) {
    throw new TaskRetryBlockedError(
      'Effective test-process heap improvement and actual container headroom are unverified; no checks dispatched.',
      'MEMORY_RECOVERY_UNAVAILABLE',
    );
  }
}

export async function prepareTestMemory(
  cm: ContainerManager,
  config: ValidationEngineConfig,
  assertCurrent: () => void = () => {},
) {
  const direct = config.testCommand && directNodeTest(config.testCommand);
  if (
    config.executionTarget !== 'local' ||
    !direct ||
    !cm.getExecutionMetadata ||
    !cm.getResourceKey
  )
    return undefined;
  // Inherited NODE_OPTIONS could preload code or change child execution. Only the
  // measured, command-local heap option or an empty inherited option is supported.
  const nonce = randomUUID().replaceAll('-', '');
  const file = `/tmp/autopod-test-memory-${nonce}.cjs`;
  const marker = `AUTOPOD_TEST_MEMORY_${nonce}:`;
  assertCurrent();
  const metadata = await cm.getExecutionMetadata(config.containerId);
  const resourceKey = await cm.getResourceKey(config.containerId);
  assertCurrent();
  if (
    metadata.podId !== config.podId ||
    !metadata.imageDigest ||
    !metadata.memoryLimitBytes ||
    !resourceKey
  )
    return undefined;
  const probe = `if(process.env.NODE_OPTIONS&&!/^--max-old-space-size=\\d+$/.test(process.env.NODE_OPTIONS))process.exit(78);console.log(JSON.stringify({heap:require('node:v8').getHeapStatistics().heap_size_limit,container:process.constrainedMemory(),pid:process.pid}))`;
  const observed = await cm.execInContainer(
    config.containerId,
    wrapValidationExecCommand(
      `${direct.assignment ? `${direct.assignment}; export NODE_OPTIONS; ` : ''}case "\${NODE_OPTIONS-}" in '') ;; --max-old-space-size=*) case "\${NODE_OPTIONS#--max-old-space-size=}" in ''|*[!0-9]*) exit 78;; esac;; *) exit 78;; esac; ${direct.node} -e '${probe.replaceAll("'", "'\\''")}'`,
      config.extraExecEnv,
      config.nonSecretExecEnv,
    ),
    {
      cwd: config.buildWorkDir ? `/workspace/${config.buildWorkDir}` : '/workspace',
      env: config.extraExecEnv,
      timeout: 10_000,
      requireObservedExit: true,
      maxOutputBytes: 4096,
      assertCurrent,
    },
  );
  assertCurrent();
  if (observed.exitCode !== 0) return undefined;
  let measured: { heap: number; container: number; pid: number };
  try {
    measured = JSON.parse(observed.stdout.trim());
  } catch {
    return undefined;
  }
  if (
    !Number.isSafeInteger(measured.heap) ||
    measured.heap <= 0 ||
    !Number.isSafeInteger(measured.pid) ||
    !Number.isSafeInteger(measured.container) ||
    measured.container <= 0
  )
    return undefined;
  const container = Math.min(measured.container, metadata.memoryLimitBytes);
  const evidence: TestProcessMemoryEvidence = {
    version: 1,
    kind: 'node-heap',
    commandHash: memoryCommandHash(config.testCommand!),
    containerId: config.containerId,
    resourceKey,
    imageDigest: metadata.imageDigest,
    heapLimitBytes: measured.heap,
    containerLimitBytes: container,
    processId: measured.pid,
  };
  // The real test process reports its own heap before test code. The PID must
  // match the fatal V8 diagnostic; a child failure cannot borrow this evidence.
  await cm.writeFile(
    config.containerId,
    file,
    `const v=require('node:v8');const heap=v.getHeapStatistics().heap_size_limit;const container=Math.min(process.constrainedMemory(),${metadata.memoryLimitBytes});if(heap!==${measured.heap}||container!==${container})process.exit(78);process.stderr.write(${JSON.stringify(marker)}+JSON.stringify({heap,container,pid:process.pid})+'\\n');`,
    { assertCurrent, singleAttempt: true, mode: 0o600 },
  );
  assertCurrent();
  return {
    evidence,
    command: `${direct.prefix} --require=${file}${direct.tests}`,
    actual(output: string, fatal: boolean): TestProcessMemoryEvidence | undefined {
      const line = output.split('\n').find((value) => value.startsWith(marker));
      if (!line) return undefined;
      try {
        const actual = JSON.parse(line.slice(marker.length));
        if (
          actual.heap !== evidence.heapLimitBytes ||
          actual.container !== evidence.containerLimitBytes ||
          !Number.isSafeInteger(actual.pid)
        )
          return undefined;
        if (fatal) {
          const end = output.lastIndexOf('FATAL ERROR:');
          const gc = output.lastIndexOf('<--- Last few GCs --->', end);
          const stack = output.lastIndexOf('<--- JS stacktrace --->', end);
          const pids = [...output.slice(gc, stack).matchAll(/\[(\d+):[^\]\n]+\]/g)];
          if (
            gc < 0 ||
            stack <= gc ||
            end <= stack ||
            !pids.length ||
            pids.some((match) => Number(match[1]) !== actual.pid) ||
            !/^FATAL ERROR:.*JavaScript heap out of memory/.test(output.slice(end))
          )
            return undefined;
        }
        return { ...evidence, processId: actual.pid };
      } catch {
        return undefined;
      }
    },
  };
}
