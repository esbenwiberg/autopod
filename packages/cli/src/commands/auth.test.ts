import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpHome = path.join(os.tmpdir(), `autopod-auth-test-${Date.now()}-${Math.random()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const stub: Record<string, unknown> = {};
  for (const k of ['red', 'green', 'dim', 'bold', 'cyan', 'yellow']) {
    stub[k] = passthrough;
  }
  return { default: stub };
});

const { registerAuthCommands } = await import('./auth.js');

function captureOutput(): {
  stdout: string[];
  logs: string[];
  errors: string[];
  exitCode: number | undefined;
  restore: () => void;
} {
  const stdout: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  const origWrite = process.stdout.write;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as typeof process.exit;

  return {
    stdout,
    logs,
    errors,
    get exitCode() {
      return exitCode;
    },
    restore: () => {
      process.stdout.write = origWrite;
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    },
  };
}

async function runAuth(args: string[]): Promise<ReturnType<typeof captureOutput>> {
  const program = new Command();
  program.exitOverride();
  registerAuthCommands(program);
  const cap = captureOutput();
  try {
    await program.parseAsync(['node', 'ap', ...args]);
  } catch (err) {
    if ((err as Error).message !== '__process_exit__' && !(err as { code?: string }).code) {
      throw err;
    }
  }
  cap.restore();
  return cap;
}

function writeCredentials(accessToken: string, expiresAt = '2099-01-01T00:00:00.000Z'): void {
  const configDir = path.join(tmpHome, '.autopod');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify(
      {
        accessToken,
        refreshToken: '',
        expiresAt,
        userId: 'user-1',
        displayName: 'Test User',
        email: 'test@example.com',
        roles: ['operator'],
      },
      null,
      2,
    ),
  );
}

describe('auth commands', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpHome, '.autopod'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('ap token', () => {
    it('prints the daemon access token from the refresh-aware token path', async () => {
      writeCredentials('access-token-123');

      const cap = await runAuth(['token']);

      expect(cap.exitCode).toBeUndefined();
      expect(cap.stdout.join('')).toBe('access-token-123\n');
    });

    it('fails clearly when no valid login exists', async () => {
      const cap = await runAuth(['token']);

      expect(cap.exitCode).toBe(2);
      expect(cap.errors.join('\n')).toContain('Not authenticated. Run: ap login');
    });

    it('does not print expired credentials', async () => {
      writeCredentials('expired-token', '2000-01-01T00:00:00.000Z');

      const cap = await runAuth(['token']);

      expect(cap.exitCode).toBe(2);
      expect(cap.stdout.join('')).toBe('');
      expect(cap.errors.join('\n')).toContain('Not authenticated. Run: ap login');
    });
  });
});
