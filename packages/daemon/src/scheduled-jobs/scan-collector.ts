import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ScheduledScanCollection,
  ScheduledScanFinding,
  ScheduledScanPolicy,
  ScheduledScannerResult,
} from '@autopod/shared';
import type { Detector } from '../security/detectors/detector.js';
import { createSecretlintDetector } from '../security/detectors/secretlint-detector.js';

const exec = promisify(execFile);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface DependencyScanResult {
  version: string;
  evidenceHash: string;
  findings: Array<{
    identity: string;
    ruleId: string;
    severity: ScheduledScanFinding['severity'];
    summary: string;
  }>;
}
export interface ScheduledCollectorDeps {
  secrets?: Detector;
  secretVersion?: () => Promise<string>;
  auditLockfile?: (path: string, content: string) => Promise<DependencyScanResult>;
}
async function secretVersion(): Promise<string> {
  const require = createRequire(import.meta.url);
  const versions: string[] = [];
  for (const name of ['@secretlint/core', '@secretlint/secretlint-rule-preset-recommend']) {
    let directory = dirname(require.resolve(name));
    let found = false;
    for (let depth = 0; depth < 5; depth++) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === name && manifest.version) {
          versions.push(`${name}@${manifest.version}`);
          found = true;
          break;
        }
      } catch {
        /* Only a matching package manifest identifies the detector. */
      }
      directory = dirname(directory);
    }
    if (!found) throw new Error('Detector version unavailable');
  }
  return versions.join(';');
}

/** Reads immutable Git objects only; never executes repository scripts. */
export async function collectScheduledScan(
  workdir: string,
  repository: string,
  policy: ScheduledScanPolicy,
  deps: ScheduledCollectorDeps = {},
  asOf = new Date().toISOString(),
): Promise<ScheduledScanCollection> {
  const currentTree = policy.scope !== 'delta';
  const result: ScheduledScanCollection = {
    scope: currentTree ? 'current_tree' : 'delta',
    version: 1,
    repository,
    baseSha: null,
    headSha: null,
    files: [],
    stacks: [],
    scanners: [],
    findings: [],
    diagnostics: [],
  };
  const git = async (...args: string[]) =>
    (await exec('git', args, { cwd: workdir, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  let totalBytes = 0;
  const blob = async (sha: string, path: string) => {
    const content = await git('cat-file', 'blob', `${sha}:${path}`);
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > 32 * 1024 * 1024) throw new Error('Total content budget exceeded');
    if (Buffer.byteLength(content) > 2 * 1024 * 1024 || content.includes('\0'))
      throw new Error('File exceeds supported text scope');
    return { path, content, sizeBytes: Buffer.byteLength(content) };
  };
  try {
    result.baseSha = (
      await git(
        'rev-parse',
        '--verify',
        '--end-of-options',
        `refs/remotes/origin/${policy.baseRef}^{commit}`,
      )
    ).trim();
    result.headSha = (
      await git(
        'rev-parse',
        '--verify',
        '--end-of-options',
        `refs/remotes/origin/${policy.headRef}^{commit}`,
      )
    ).trim();
    if (![result.baseSha, result.headSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)))
      throw new Error('Invalid commit identity');
    if (policy.windowHours !== undefined) {
      if (policy.baseRef !== policy.headRef) throw new Error('Window must name a single branch');
      const end = Date.parse(asOf);
      const start = end - policy.windowHours * 3600000;
      if (
        !Number.isFinite(end) ||
        !Number.isInteger(policy.windowHours) ||
        policy.windowHours < 1 ||
        policy.windowHours > 720
      )
        throw new Error('Invalid window');
      // Enumerate the complete bounded first-parent history, rather than using
      // --since, which may prune traversal at older timestamps. A noncontiguous
      // window cannot be represented by one net tree delta without widening it.
      const history = (
        await git('rev-list', '--first-parent', '--topo-order', '--timestamp', result.headSha, '--')
      )
        .trim()
        .split('\n')
        .map((line) => {
          const match = /^(\d+) ([a-f0-9]{40,64})$/.exec(line);
          if (!match?.[1] || !match[2]) throw new Error('Invalid history record');
          return { time: Number(match[1]) * 1000, sha: match[2] };
        });
      const selected = history.filter((commit) => commit.time > start && commit.time <= end);
      if (
        selected.length > 5000 ||
        history.some((commit) => commit.time > end) ||
        selected.some((commit, index) => history[index]?.sha !== commit.sha)
      )
        throw new Error('Window is not a bounded contiguous first-parent delta');
      result.window = {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        semantics: 'first_parent_committer_time_net_delta',
        selectedCommits: selected.map((commit) => commit.sha),
      };
      result.baseKind = 'commit';
      const previous = history[selected.length];
      if (!selected.length) result.baseSha = result.headSha;
      else if (previous) result.baseSha = previous.sha;
      else {
        // A window containing the repository root compares against a real empty
        // tree object in this disposable local Git store (no source mutation).
        result.baseSha = (await git('hash-object', '-w', '-t', 'tree', '/dev/null')).trim();
        result.baseKind = 'empty_tree';
      }
    }
    const raw = (
      await git(
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--name-status',
        '-z',
        result.baseSha,
        result.headSha,
        '--',
      )
    ).split('\0');
    if (raw.at(-1) === '') raw.pop();
    if (raw.length % 2 || raw.length > 400)
      throw new Error('Delta is malformed or exceeds 200 paths');
    for (let index = 0; index < raw.length; index += 2) {
      const change = raw[index];
      const path = raw[index + 1];
      if (!path || !change || !['A', 'M', 'D', 'T'].includes(change))
        throw new Error('Unsupported delta record');
      result.files.push({
        path,
        change: change === 'A' ? 'added' : change === 'D' ? 'deleted' : 'modified',
      });
    }
    // Preserve delta context independently of the explicit current-tree scan scope.
    const names = (await git('ls-tree', '-r', '--name-only', '-z', result.headSha)).split('\0');
    if (currentTree) {
      result.scannedPaths = names.filter(Boolean);
      if (result.scannedPaths.length > 10000) throw new Error('Tree path budget exceeded');
    }
    result.stacks = [
      ...new Set(
        names.flatMap((name) =>
          /(^|\/)package\.json$/.test(name)
            ? ['node']
            : /\.(csproj|fsproj)$/.test(name)
              ? ['dotnet']
              : /(^|\/)(pyproject\.toml|requirements\.txt)$/.test(name)
                ? ['python']
                : [],
        ),
      ),
    ].sort();
  } catch {
    result.diagnostics.push(
      'Exact scan scope enumeration unavailable or exceeded resource limits; no clean result is available.',
    );
    return result;
  }
  if (!currentTree && !result.files.length) {
    result.scanners = policy.scanners.map((scanner) => ({
      scanner,
      version: null,
      status: 'skipped_empty',
      findingCount: 0,
    }));
    return result;
  }
  const deadline = Date.now() + 60000;
  const scanFiles = currentTree
    ? (result.scannedPaths ?? []).map((path) => ({ path, change: 'added' as const }))
    : result.files;
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Collection time budget exceeded')),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  for (const scanner of policy.scanners) {
    const observation: ScheduledScannerResult = {
      scanner,
      version: null,
      status: 'completed',
      findingCount: 0,
    };
    result.scanners.push(observation);
    const beforeCount = result.findings.length;
    try {
      if (scanner === 'secrets') {
        const detector = deps.secrets ?? createSecretlintDetector();
        observation.version = await bounded((deps.secretVersion ?? secretVersion)());
        if (!detector.scanWithBaselineIdentity)
          throw new Error('Detector cannot report incomplete execution');
        await bounded(detector.warmup());
        let incomplete = false;
        for (const file of scanFiles) {
          if (Date.now() >= deadline) throw new Error('Collection time budget exceeded');
          if (file.change === 'deleted') continue;
          try {
            const current = await bounded(
              detector.scanWithBaselineIdentity(await blob(result.headSha, file.path)),
            );
            if (!current) throw new Error('Secret scanner execution incomplete');
            const baseline =
              file.change === 'added'
                ? []
                : await bounded(
                    detector.scanWithBaselineIdentity(await blob(result.baseSha, file.path)),
                  );
            if (!baseline) throw new Error('Secret baseline unavailable');
            const previous = new Map<string, number>();
            for (const finding of baseline)
              previous.set(finding.identity, (previous.get(finding.identity) ?? 0) + 1);
            for (const { identity, finding } of current) {
              const count = previous.get(identity) ?? 0;
              if (count > 0) {
                previous.set(identity, count - 1);
                continue;
              }
              if (result.findings.length >= 1000) throw new Error('Finding budget exceeded');
              result.findings.push({
                id: hash(
                  JSON.stringify([repository, scanner, file.path, finding.ruleId, identity]),
                ),
                scanner,
                file: file.path,
                line: finding.line,
                ruleId: finding.ruleId ?? 'secret',
                severity: finding.severity === 'medium' ? 'moderate' : finding.severity,
                summary: 'Secret finding [REDACTED]',
              });
            }
          } catch {
            incomplete = true;
            if (totalBytes >= 32 * 1024 * 1024 || result.findings.length >= 1000) break;
          }
        }
        if (incomplete) throw new Error('Secret coverage incomplete');
      } else {
        const files = scanFiles.filter(
          (file) =>
            file.change !== 'deleted' &&
            /(^|\/)(package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|packages\.lock\.json|requirements\.txt|poetry\.lock|pyproject\.toml|Pipfile(?:\.lock)?|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|[^/]+\.(?:csproj|fsproj))$/.test(
              file.path,
            ),
        );
        if (!files.length) {
          observation.status = 'not_applicable';
          observation.diagnostic = 'No dependency manifests or lockfiles in the selected scope.';
          continue;
        }
        if (!deps.auditLockfile) {
          observation.status = 'unavailable';
          throw new Error('Dependency audit capability unavailable');
        }
        const versions = new Set<string>();
        const evidence: string[] = [];
        let incomplete = false;
        for (const file of files) {
          if (Date.now() >= deadline) throw new Error('Collection time budget exceeded');
          if (!/(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(file.path)) {
            const lock = file.path.replace(/package\.json$/, 'package-lock.json');
            if (
              file.path.endsWith('package.json') &&
              files.some(
                (candidate) =>
                  candidate.path === lock ||
                  candidate.path === file.path.replace(/package\.json$/, 'npm-shrinkwrap.json'),
              )
            )
              continue;
            incomplete = true;
            continue;
          }
          try {
            const scanned = await bounded(
              deps.auditLockfile(file.path, (await blob(result.headSha, file.path)).content),
            );
            versions.add(scanned.version);
            evidence.push(scanned.evidenceHash);
            for (const finding of scanned.findings) {
              if (result.findings.length >= 1000) throw new Error('Finding budget exceeded');
              result.findings.push({
                id: hash(JSON.stringify([repository, scanner, file.path, finding.identity])),
                scanner,
                file: file.path,
                ruleId: finding.ruleId,
                severity: finding.severity,
                summary: finding.summary,
              });
            }
          } catch {
            incomplete = true;
            if (totalBytes >= 32 * 1024 * 1024 || result.findings.length >= 1000) break;
          }
        }
        observation.version = versions.size ? [...versions].sort().join(';') : null;
        if (evidence.length) observation.evidenceHash = hash(JSON.stringify(evidence));
        if (incomplete) throw new Error('Dependency coverage incomplete');
      }
      observation.findingCount = result.findings.length - beforeCount;
    } catch {
      observation.status = observation.status === 'unavailable' ? 'unavailable' : 'failed';
      observation.findingCount = null;
      observation.diagnostic =
        'Requested scanner did not complete within its supported exact scope; total findings are unknown.';
    }
  }
  result.findings = [
    ...new Map(result.findings.map((finding) => [finding.id, finding])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
