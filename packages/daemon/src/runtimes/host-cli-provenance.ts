import { constants, statSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutopodError } from '@autopod/shared';
import type { ClaudeCliOptions, runClaudeCli } from './run-claude-cli.js';

export interface HostCliDispatchEvidence {
  model: string;
  cliPath: string | null;
  cliVersion: string | null;
  status: 'checked' | 'blocked';
}

/** Probes only a fixed CLI --version command; prompts are never passed to the probe. */
export async function runWithHostCliProvenance(
  opts: ClaudeCliOptions,
  run: typeof runClaudeCli,
): ReturnType<typeof runClaudeCli> {
  const started = performance.now();
  const unavailable = () =>
    new AutopodError(
      'Host reviewer CLI identity could not be verified. Reconcile the installed CLI and retry; no review was dispatched.',
      'PREFLIGHT_HOST_CLI_UNAVAILABLE',
      409,
    );
  const remaining = () => {
    const value = opts.timeout - (performance.now() - started);
    if (!Number.isFinite(value) || value <= 0) throw unavailable();
    return value;
  };
  const evidence: HostCliDispatchEvidence = {
    model: opts.model,
    cliPath: null,
    cliVersion: null,
    status: 'blocked',
  };
  opts.beforeSpawn?.();
  const spawnOptions = {
    ...opts.spawnOptions,
    env: { ...(opts.spawnOptions?.env ?? process.env) },
  };
  const cwd =
    spawnOptions.cwd instanceof URL
      ? fileURLToPath(spawnOptions.cwd)
      : (spawnOptions.cwd ?? process.cwd());
  const command = opts.command ?? 'claude';
  let fingerprint: string;
  const identify = (entry: Awaited<ReturnType<typeof stat>>) =>
    [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs, entry.mode].join(':');
  try {
    remaining();
    const search = spawnOptions.env.PATH ?? '/usr/bin:/bin';
    if (search.length > 16384 || search.split(path.delimiter).length > 128) throw unavailable();
    const candidates = command.includes(path.sep)
      ? [path.resolve(cwd, command)]
      : search.split(path.delimiter).map((directory) => path.resolve(cwd, directory, command));
    for (const candidate of candidates) {
      remaining();
      try {
        await access(candidate, constants.X_OK);
        const resolved = await realpath(candidate);
        const entry = await stat(resolved);
        if (
          !entry.isFile() ||
          resolved.length > 1024 ||
          [...resolved].some((character) => character.charCodeAt(0) < 32)
        )
          continue;
        evidence.cliPath = resolved;
        fingerprint = identify(entry);
        break;
      } catch {
        /* Continue searching the same captured PATH, without rebinding credentials. */
      }
    }
    if (!evidence.cliPath) throw unavailable();
    const result = await run({
      ...opts,
      recordHostDispatch: undefined,
      command: evidence.cliPath,
      args: ['--version'],
      input: '',
      outputFormat: 'text',
      maxBuffer: 4096,
      timeout: Math.min(5000, remaining()),
      spawnOptions,
    });
    const match = result.stdout.trim().match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    const version = match?.slice(1).map(Number);
    if (!version || version.some((value) => !Number.isSafeInteger(value))) throw unavailable();
    evidence.cliVersion = version.join('.');
    remaining();
  } catch (error) {
    opts.beforeSpawn?.();
    opts.recordHostDispatch?.(evidence);
    throw error;
  }
  const cliPath = evidence.cliPath;
  return run({
    ...opts,
    recordHostDispatch: undefined,
    command: cliPath,
    spawnOptions,
    timeout: remaining(),
    beforeSpawn: () => {
      opts.beforeSpawn?.();
      // Replaced/edited executables invalidate the probe; this is metadata fencing,
      // not a claim of a binary hash or transitive dependency identity.
      try {
        if (identify(statSync(cliPath)) !== fingerprint) throw unavailable();
      } catch {
        opts.recordHostDispatch?.(evidence);
        throw unavailable();
      }
      opts.recordHostDispatch?.({ ...evidence, status: 'checked' });
    },
  });
}
