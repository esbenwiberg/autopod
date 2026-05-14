import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-pod host directory bind-mounted into the container at
 * `~/.codex/sessions/` so the Codex CLI's conversation rollout files
 * (`YYYY/MM/DD/rollout-*.jsonl`) survive a container respawn during
 * sleep/wake or crash recovery.
 *
 * Without this mount, every recovery spawns a fresh container, Codex's local
 * session state is empty, `exec resume <id>` fails silently, and the agent
 * starts over from scratch — burning the prior run's tokens.
 *
 * Override the host root with `AUTOPOD_CODEX_STATE_DIR` (e.g. for tests).
 */
export function codexStateDirForPod(podId: string): string {
  const root =
    process.env.AUTOPOD_CODEX_STATE_DIR ?? path.join(os.homedir(), '.autopod', 'codex-state');
  return path.join(root, podId);
}

export async function ensureCodexStateDir(podId: string): Promise<string> {
  const dir = codexStateDirForPod(podId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupCodexState(podId: string): Promise<void> {
  const dir = codexStateDirForPod(podId);
  await rm(dir, { recursive: true, force: true });
}
