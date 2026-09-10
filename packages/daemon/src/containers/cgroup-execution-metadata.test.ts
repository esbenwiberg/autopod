import { posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import {
  CGROUP_EXECUTION_METADATA_PROBE,
  parseCgroupExecutionMetadata,
} from './cgroup-execution-metadata.js';

function execute(files: Record<string, string>) {
  let stdout = '';
  runInNewContext(
    CGROUP_EXECUTION_METADATA_PROBE,
    {
      Buffer,
      require(name: string) {
        if (name === 'node:path') return { posix };
        if (name !== 'node:fs') throw new Error('unexpected module');
        return {
          openSync(file: string) {
            if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return file;
          },
          readSync(file: string, buffer: Buffer) {
            return buffer.write(files[file] ?? '');
          },
          closeSync() {},
        };
      },
      process: {
        stdout: {
          write(value: string) {
            stdout += value;
          },
        },
      },
    },
    { timeout: 1000 },
  );
  return JSON.parse(stdout);
}
it('reads effective ancestor bounds from a namespaced v2 hierarchy, without substituting requested resources', () => {
  const base = {
    '/proc/self/cgroup': '0::/tenant/worker',
    '/proc/self/mountinfo': '1 0 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw',
    '/sys/fs/cgroup/worker/memory.max': '4294967296',
    '/sys/fs/cgroup/memory.max': '2147483648',
    '/sys/fs/cgroup/worker/cpu.max': '200000 100000',
    '/sys/fs/cgroup/cpu.max': '50000 100000',
  };
  expect(execute(base)).toEqual({ memoryLimitBytes: 2147483648, cpuLimit: 0.5 });
  expect(
    execute({ ...base, '/sys/fs/cgroup/memory.max': 'unreadable' }).memoryLimitBytes,
  ).toBeNull();
  expect(execute({})).toEqual({ memoryLimitBytes: null, cpuLimit: null });
});
it('reads v1 controller mounts and treats unbounded sentinels as unknown capacity', () => {
  expect(
    execute({
      '/proc/self/cgroup': '2:memory:/\n3:cpu,cpuacct:/',
      '/proc/self/mountinfo':
        '1 0 0:1 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n2 0 0:2 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
    }),
  ).toEqual({ memoryLimitBytes: null, cpuLimit: null });
});
it('rejects malformed or failed probes and never manufactures an image or network identity', () => {
  for (const stdout of ['malformed', 'null', '{"memoryLimitBytes":-1,"cpuLimit":"2"}']) {
    expect(parseCgroupExecutionMetadata({ exitCode: 0, stdout, stderr: '' })).toEqual({
      imageDigest: null,
      memoryLimitBytes: null,
      cpuLimit: null,
      networkMode: null,
    });
  }
  expect(
    parseCgroupExecutionMetadata({
      exitCode: 0,
      stdout: '{"memoryLimitBytes":4294967296,"cpuLimit":2}',
      stderr: '',
    }),
  ).toEqual({ imageDigest: null, memoryLimitBytes: 4294967296, cpuLimit: 2, networkMode: null });
});
