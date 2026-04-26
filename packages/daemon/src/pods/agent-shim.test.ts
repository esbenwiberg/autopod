import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SHIM_SCRIPT } from './pod-manager.js';

// Regression: the shim is built from a JS template literal, so any unescaped
// `${...}` gets interpolated by JS at compile time and silently corrupts the
// shell script. These tests pin the rendered output and exercise it under sh.

describe('AGENT_SHIM_SCRIPT — rendered output', () => {
  it('preserves shell parameter expansions through JS template processing', () => {
    expect(AGENT_SHIM_SCRIPT).toContain('file_var="${1}_FILE"');
    expect(AGENT_SHIM_SCRIPT).toContain('eval "path=\\${$file_var:-}"');
    expect(AGENT_SHIM_SCRIPT).not.toContain('file_var="1_FILE"');
    expect(AGENT_SHIM_SCRIPT).not.toContain('eval "path=${$file_var:-}"');
  });

  it('reads each known *_FILE env var', () => {
    expect(AGENT_SHIM_SCRIPT).toContain('_read_file_var ANTHROPIC_API_KEY');
    expect(AGENT_SHIM_SCRIPT).toContain('_read_file_var OPENAI_API_KEY');
    expect(AGENT_SHIM_SCRIPT).toContain('_read_file_var COPILOT_GITHUB_TOKEN');
    expect(AGENT_SHIM_SCRIPT).toContain('_read_file_var VSS_NUGET_EXTERNAL_FEED_ENDPOINTS');
  });
});

describe('AGENT_SHIM_SCRIPT — runtime behaviour', () => {
  let workDir: string;
  let shimPath: string;
  let credPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'autopod-shim-'));
    shimPath = join(workDir, 'agent-shim.sh');
    credPath = join(workDir, 'anthropic.key');
    writeFileSync(shimPath, AGENT_SHIM_SCRIPT, { mode: 0o500 });
    writeFileSync(credPath, 'sk-test-secret-value');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('exports the real credential, unsets the *_FILE pointer, and exec-s the agent', () => {
    const stdout = execFileSync(
      'sh',
      [
        shimPath,
        'sh',
        '-c',
        'printf "%s\\n%s\\n" "${ANTHROPIC_API_KEY}" "${ANTHROPIC_API_KEY_FILE:-unset}"',
      ],
      {
        env: { ...process.env, ANTHROPIC_API_KEY_FILE: credPath },
        encoding: 'utf8',
      },
    );
    const [apiKey, fileVar] = stdout.trim().split('\n');
    expect(apiKey).toBe('sk-test-secret-value');
    expect(fileVar).toBe('unset');
  });

  it('is a no-op when no *_FILE env vars are set', () => {
    const stdout = execFileSync(
      'sh',
      [shimPath, 'sh', '-c', 'printf "%s\\n" "${ANTHROPIC_API_KEY:-empty}"'],
      { env: { ...process.env }, encoding: 'utf8' },
    );
    expect(stdout.trim()).toBe('empty');
  });
});
