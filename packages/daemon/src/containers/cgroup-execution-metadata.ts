import type { ContainerExecutionMetadata, ExecResult } from '../interfaces/container-manager.js';

/** Fixed Linux cgroup read set; no shell or repository-provided paths/commands. */
export const CGROUP_EXECUTION_METADATA_PROBE = String.raw`
const fs = require('node:fs');
const path = require('node:path').posix;
function read(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(65537);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 65536) throw new Error('metadata bound');
    return buffer.subarray(0, size).toString('utf8').trim();
  } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function positive(value) {
  if (!/^\d+$/.test(value ?? '')) throw new Error('invalid limit');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('unknown or unlimited limit');
  return n;
}
const memberships = (read('/proc/self/cgroup') ?? '').split('\n').map(line => {
  const match = line.match(/^\d+:([^:]*):(\/.*)$/);
  return match ? { controllers: match[1].split(','), path: match[2] } : null;
}).filter(Boolean);
const decode = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const mounts = (read('/proc/self/mountinfo') ?? '').split('\n').map(line => {
  const halves = line.split(' - '); if (halves.length !== 2) return null;
  const fields = halves[0].split(' '); const extra = halves[1].split(' ');
  return fields.length >= 6 && ['cgroup','cgroup2'].includes(extra[0])
    ? { root: decode(fields[3]), mount: decode(fields[4]), type: extra[0], controllers: extra[2].split(',') } : null;
}).filter(Boolean);
function limits(controller, files, parse) {
  const membership = memberships.find(m => m.controllers.includes(controller)) ?? memberships.find(m => m.controllers[0] === '');
  if (!membership) return null;
  const mount = mounts.find(m => (m.type === 'cgroup2' ? membership.controllers[0] === '' : m.controllers.includes(controller)) &&
    (membership.path === m.root || membership.path.startsWith(m.root === '/' ? '/' : m.root + '/')));
  if (!mount) return null;
  const relative = path.relative(mount.root, membership.path);
  if (relative.startsWith('..')) return null;
  let current = path.join(mount.mount, relative); const values = [];
  for (let depth = 0; depth < 64; depth++) {
    const names = files[mount.type];
    const contents = names.map(name => read(path.join(current, name)));
    if (contents.some(value => value !== null)) {
      const value = parse(contents, mount.type);
      if (value !== null) values.push(value);
    }
    if (current === mount.mount) return values.length ? Math.min(...values) : null;
    current = path.dirname(current);
  }
  return null;
}
let memoryLimitBytes = null, cpuLimit = null;
try { memoryLimitBytes = limits('memory', { cgroup2:['memory.max'], cgroup:['memory.limit_in_bytes'] }, ([value]) => {
  if (value === 'max') return null;
  // v1's huge sentinel is an unbounded limit, not available memory.
  if (/^\d+$/.test(value ?? '') && BigInt(value) >= 2n ** 60n) return null;
  return positive(value);
}); } catch {}
try { cpuLimit = limits('cpu', { cgroup2:['cpu.max'], cgroup:['cpu.cfs_quota_us','cpu.cfs_period_us'] }, (values, type) => {
  const [quota, period] = type === 'cgroup2' ? (values[0] ?? '').split(/\s+/) : values;
  if (quota === 'max' || quota === '-1') return null;
  return positive(quota) / positive(period);
}); } catch {}
process.stdout.write(JSON.stringify({memoryLimitBytes,cpuLimit}));
`;

/** Unknown image/network stay unknown; requested spawn values are not actual evidence. */
export function parseCgroupExecutionMetadata(result: ExecResult): ContainerExecutionMetadata {
  const unknown: ContainerExecutionMetadata = {
    imageDigest: null,
    memoryLimitBytes: null,
    cpuLimit: null,
    networkMode: null,
  };
  if (result.exitCode !== 0 || result.stdout.length > 4096) return unknown;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return {
      ...unknown,
      memoryLimitBytes:
        typeof parsed.memoryLimitBytes === 'number' &&
        Number.isSafeInteger(parsed.memoryLimitBytes) &&
        parsed.memoryLimitBytes > 0
          ? parsed.memoryLimitBytes
          : null,
      cpuLimit:
        typeof parsed.cpuLimit === 'number' &&
        Number.isFinite(parsed.cpuLimit) &&
        parsed.cpuLimit > 0
          ? parsed.cpuLimit
          : null,
    };
  } catch {
    return unknown;
  }
}
