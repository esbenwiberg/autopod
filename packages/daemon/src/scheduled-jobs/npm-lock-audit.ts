import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ScheduledScanFinding } from '@autopod/shared';
import type { DependencyScanResult } from './scan-collector.js';

const exec = promisify(execFile);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid audit object');
  return value as Record<string, unknown>;
}
export function normalizeNpmAudit(stdout: string, version: string): DependencyScanResult {
  const report = object(JSON.parse(stdout));
  if (report.auditReportVersion !== 2 || report.error)
    throw new Error('Unsupported or incomplete audit response');
  const vulnerabilities = object(report.vulnerabilities);
  const totals = object(object(report.metadata).vulnerabilities);
  if (
    typeof totals.total !== 'number' ||
    !Number.isSafeInteger(totals.total) ||
    totals.total < 0 ||
    totals.total !== Object.keys(vulnerabilities).length ||
    ['info', 'low', 'moderate', 'high', 'critical'].some(
      (severity) => !Number.isSafeInteger(totals[severity]) || Number(totals[severity]) < 0,
    ) ||
    ['info', 'low', 'moderate', 'high', 'critical'].reduce(
      (sum, severity) => sum + Number(totals[severity]),
      0,
    ) !== totals.total
  )
    throw new Error('Audit coverage counts are inconsistent');
  const findings: DependencyScanResult['findings'] = [];
  for (const [name, value] of Object.entries(vulnerabilities)) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
      throw new Error('Invalid package identity');
    const row = object(value);
    if (
      !['info', 'low', 'moderate', 'high', 'critical'].includes(String(row.severity)) ||
      !Array.isArray(row.via) ||
      !row.via.length
    )
      throw new Error('Incomplete vulnerability identity');
    const advisories = row.via
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const advisory = object(item);
        if (typeof advisory.source !== 'number' && typeof advisory.url !== 'string')
          throw new Error('Advisory identity unavailable');
        return String(advisory.source ?? advisory.url);
      });
    for (const advisory of advisories.length ? advisories : [`meta:${name}`])
      findings.push({
        identity: JSON.stringify([name, advisory]),
        ruleId: `npm:${advisory}`,
        severity: row.severity as ScheduledScanFinding['severity'],
        summary: `Known ${row.severity} vulnerability in dependency ${name} within this changed lockfile.`,
      });
  }
  return { version, findings, evidenceHash: createHash('sha256').update(stdout).digest('hex') };
}

/** Standard npm audit sends lockfile dependency metadata to the public npm registry.
 * Runs in a disposable directory with no repository code, scripts, extensions or npmrc.
 * It never installs, applies audit fixes, or modifies the source checkout.
 */
export async function auditNpmLockfile(
  _path: string,
  content: string,
): Promise<DependencyScanResult> {
  const lock = object(JSON.parse(content));
  if (![2, 3].includes(Number(lock.lockfileVersion)))
    throw new Error('Only npm lockfile versions 2 and 3 are supported');
  const root = object(object(lock.packages)['']);
  const directory = await mkdtemp(join(tmpdir(), 'autopod-lock-audit-'));
  try {
    await writeFile(join(directory, 'package-lock.json'), content, { mode: 0o600 });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: typeof root.name === 'string' ? root.name : 'autopod-scan-input',
        version: typeof root.version === 'string' ? root.version : '0.0.0',
        private: true,
        dependencies: root.dependencies ?? {},
        devDependencies: root.devDependencies ?? {},
        optionalDependencies: root.optionalDependencies ?? {},
      }),
      { mode: 0o600 },
    );
    await writeFile(join(directory, 'empty.npmrc'), '', { mode: 0o600 });
    await writeFile(join(directory, 'global.npmrc'), '', { mode: 0o600 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
    );
    env.NODE_ENV = 'development';
    const version = (
      await exec('npm', ['--version'], { cwd: directory, env, timeout: 10000, maxBuffer: 4096 })
    ).stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('npm version unavailable');
    const args = [
      'audit',
      '--json',
      '--package-lock-only',
      '--ignore-scripts',
      '--include=dev',
      '--include=optional',
      '--include=peer',
      '--registry=https://registry.npmjs.org/',
      '--userconfig',
      join(directory, 'empty.npmrc'),
      '--globalconfig',
      join(directory, 'global.npmrc'),
      '--cache',
      join(directory, 'cache'),
    ];
    let stdout: string;
    try {
      stdout = (
        await exec('npm', args, { cwd: directory, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
      ).stdout;
    } catch (error) {
      // npm exits 1 when vulnerabilities exist. Kills/timeouts/other failures
      // cannot become a zero-findings result even when partial stdout exists.
      const failure = error as { code?: number; stdout?: string; killed?: boolean };
      if (failure.code !== 1 || failure.killed || !failure.stdout)
        throw new Error('npm audit unavailable');
      stdout = failure.stdout;
    }
    return normalizeNpmAudit(stdout, `npm@${version};audit-adapter-v1`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
