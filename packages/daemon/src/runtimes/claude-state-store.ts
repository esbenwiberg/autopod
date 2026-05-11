import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Per-pod host directory bind-mounted into the container at
 * `~/.claude/projects/` so the Claude CLI's conversation history (the
 * `<session-uuid>.jsonl` files Claude looks up on `--resume`) survives a
 * container respawn during sleep/wake or crash recovery.
 *
 * Without this mount, every recovery spawns a fresh container, Claude's local
 * state is empty, `--resume` fails with "No conversation found with session
 * ID", and the agent exits silently — burning the prior run's tokens.
 *
 * Override the host root with `AUTOPOD_CLAUDE_STATE_DIR` (e.g. for tests).
 */
export function claudeStateDirForPod(podId: string): string {
  const root =
    process.env.AUTOPOD_CLAUDE_STATE_DIR ?? path.join(os.homedir(), '.autopod', 'claude-state');
  return path.join(root, podId);
}

export async function ensureClaudeStateDir(podId: string): Promise<string> {
  const dir = claudeStateDirForPod(podId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupClaudeState(podId: string): Promise<void> {
  const dir = claudeStateDirForPod(podId);
  await rm(dir, { recursive: true, force: true });
}
