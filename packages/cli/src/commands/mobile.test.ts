import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock os.homedir + child_process.execFileSync before importing the module
// under test, so its module-scoped reads/exec calls go through the mocks.

const tmpHome = path.join(os.tmpdir(), `autopod-mobile-test-${Date.now()}-${Math.random()}`);
let mockTailscaleOutput: string | Error | null = null;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    if (mockTailscaleOutput === null) throw new Error('not configured');
    if (mockTailscaleOutput instanceof Error) throw mockTailscaleOutput;
    return mockTailscaleOutput;
  }),
}));

// chalk would interpret as colour codes — disable for clean string assertions
vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const stub: Record<string, unknown> = {};
  for (const k of ['red', 'green', 'dim', 'bold', 'cyan', 'yellow']) {
    stub[k] = passthrough;
  }
  return { default: stub };
});

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn() },
  generate: vi.fn(),
}));

const { registerMobileCommands } = await import('./mobile.js');

function captureOutput(): {
  logs: string[];
  errors: string[];
  exitCode: number | undefined;
  restore: () => void;
} {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exit;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  // Don't let action handlers actually exit the test runner
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('__process_exit__');
  }) as typeof process.exit;
  return {
    logs,
    errors,
    get exitCode() {
      return exitCode;
    },
    restore: () => {
      console.log = origLog;
      console.error = origErr;
      process.exit = origExit;
    },
  };
}

async function runMobile(args: string[]): Promise<ReturnType<typeof captureOutput>> {
  const program = new Command();
  program.exitOverride(); // commander throws instead of process.exit on its own errors
  registerMobileCommands(program);
  const cap = captureOutput();
  try {
    await program.parseAsync(['node', 'ap', 'mobile', ...args]);
  } catch (err) {
    // Swallow our forced exit and Commander errors so the test can inspect output
    if ((err as Error).message !== '__process_exit__' && !(err as { code?: string }).code) {
      throw err;
    }
  }
  cap.restore();
  return cap;
}

describe('ap mobile pair', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(path.join(tmpHome, '.autopod'), { recursive: true });
    mockTailscaleOutput = null;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('fails with a clear message when ~/.autopod/dev-token is missing', async () => {
    mockTailscaleOutput = JSON.stringify({ Self: { DNSName: 'm.tail1.ts.net.' } });
    const cap = await runMobile(['pair']);
    expect(cap.exitCode).toBe(1);
    expect(cap.errors.join('\n')).toContain('No dev token');
    expect(cap.errors.join('\n')).toContain('AUTOPOD_ALLOW_DEV_AUTH');
  });

  it('builds a route-friendly URL with the token in the fragment, not the request query', async () => {
    fs.writeFileSync(path.join(tmpHome, '.autopod', 'dev-token'), 'deadbeefcafe\n');
    mockTailscaleOutput = JSON.stringify({ Self: { DNSName: 'mymac.tail1234.ts.net.' } });

    const cap = await runMobile(['pair']);
    const all = cap.logs.join('\n');
    expect(all).toContain('https://mymac.tail1234.ts.net/mobile/#/pair?token=deadbeefcafe');
    // Negative check: token must not appear before the URL fragment.
    expect(all).not.toMatch(/\/mobile\/\?token=/);
  });

  it('respects --host override and skips tailscale lookup', async () => {
    fs.writeFileSync(path.join(tmpHome, '.autopod', 'dev-token'), 'tok123');
    // Tailscale would fail — proves we don't call it
    mockTailscaleOutput = new Error('tailscale not running');

    const cap = await runMobile(['pair', '--host', 'override.example.ts.net']);
    expect(cap.exitCode).toBeUndefined();
    expect(cap.logs.join('\n')).toContain(
      'https://override.example.ts.net/mobile/#/pair?token=tok123',
    );
  });

  it('accepts an explicit daemon token for VM pairing without a local token file', async () => {
    mockTailscaleOutput = new Error('tailscale not running');

    const cap = await runMobile(['pair', '--host', 'vm.tail1234.ts.net', '--token', 'vm-token']);

    expect(cap.exitCode).toBeUndefined();
    expect(cap.logs.join('\n')).toContain(
      'https://vm.tail1234.ts.net/mobile/#/pair?token=vm-token',
    );
  });

  it('fails clearly when neither tailscale nor --host yields a hostname', async () => {
    fs.writeFileSync(path.join(tmpHome, '.autopod', 'dev-token'), 'tok123');
    mockTailscaleOutput = new Error('not installed');

    const cap = await runMobile(['pair']);
    expect(cap.exitCode).toBe(1);
    expect(cap.errors.join('\n')).toContain('Could not determine Tailscale hostname');
  });
});

describe('ap mobile serve-instructions', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpHome, { recursive: true });
    mockTailscaleOutput = null;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('prints the tailscale serve command + pair next-step', async () => {
    mockTailscaleOutput = JSON.stringify({ Self: { DNSName: 'mymac.tail1234.ts.net.' } });
    const cap = await runMobile(['serve-instructions']);
    const out = cap.logs.join('\n');
    expect(out).toContain('tailscale serve --bg --https=443 http://127.0.0.1:3100');
    expect(out).toContain('mymac.tail1234.ts.net');
    expect(out).toContain('ap mobile pair');
  });
});
