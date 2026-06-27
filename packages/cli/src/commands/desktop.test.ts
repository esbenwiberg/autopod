import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

// chalk would inject colour codes — disable for clean string assertions.
vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const stub: Record<string, unknown> = {};
  for (const k of ['red', 'green', 'dim', 'bold', 'cyan', 'yellow']) {
    stub[k] = passthrough;
  }
  return { default: stub };
});

const { buildConnectDeepLink, registerDesktopCommands } = await import('./desktop.js');

describe('buildConnectDeepLink', () => {
  it('encodes the daemon URL into the query', () => {
    const link = buildConnectDeepLink({ url: 'http://localhost:3100' });
    const parsed = new URL(link);
    expect(parsed.protocol).toBe('autopod:');
    expect(parsed.host).toBe('connect');
    expect(parsed.searchParams.get('url')).toBe('http://localhost:3100');
  });

  it('omits optional params when not provided', () => {
    const link = buildConnectDeepLink({ url: 'http://localhost:3100' });
    const parsed = new URL(link);
    expect(parsed.searchParams.get('name')).toBeNull();
    expect(parsed.searchParams.get('authKind')).toBeNull();
    expect(parsed.searchParams.get('token')).toBeNull();
  });

  it('includes authKind, name, and token when provided', () => {
    const link = buildConnectDeepLink({
      url: 'https://daemon.example.com',
      name: 'prod',
      authKind: 'entra',
      token: 'abc 123',
    });
    const parsed = new URL(link);
    expect(parsed.searchParams.get('authKind')).toBe('entra');
    expect(parsed.searchParams.get('name')).toBe('prod');
    // Round-trips through URLSearchParams encoding.
    expect(parsed.searchParams.get('token')).toBe('abc 123');
  });
});

describe('ap desktop platform guard', () => {
  const origPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform });
    vi.restoreAllMocks();
  });

  it('refuses to run on non-macOS with a clear message', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code}__`);
    }) as typeof process.exit);

    const program = new Command();
    program.exitOverride();
    registerDesktopCommands(program);

    await expect(program.parseAsync(['node', 'ap', 'desktop'])).rejects.toThrow('__exit_1__');
    expect(errors.join('\n')).toContain('macOS-only');

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
