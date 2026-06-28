import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const command = args[0];
    const callback = args.find(
      (arg): arg is (err: Error | null, stdout: string, stderr: string) => void =>
        typeof arg === 'function',
    );
    let stdout = '';
    if (command === 'pgrep') {
      stdout = '12345\n';
    } else if (command === 'ps') {
      stdout = ' 12345 T /Applications/Autopod.app/Contents/MacOS/Autopod\n';
    }
    callback?.(null, stdout, '');
    return { pid: 1234 };
  }),
);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

// chalk would inject colour codes — disable for clean string assertions.
vi.mock('chalk', () => {
  const passthrough = (s: string) => s;
  const stub: Record<string, unknown> = {};
  for (const k of ['red', 'green', 'dim', 'bold', 'cyan', 'yellow']) {
    stub[k] = passthrough;
  }
  return { default: stub };
});

const {
  buildConnectDeepLink,
  findStoppedDesktopProcessIds,
  launchDesktopApp,
  registerDesktopCommands,
} = await import('./desktop.js');

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

describe('findStoppedDesktopProcessIds', () => {
  it('returns only stopped installed Autopod app processes', () => {
    expect(
      findStoppedDesktopProcessIds(`
        111 S /Applications/Autopod.app/Contents/MacOS/Autopod
        222 T /Applications/Autopod.app/Contents/MacOS/Autopod
        333 T /private/tmp/Autopod.app/Contents/MacOS/Autopod
        444 T /Applications/Other.app/Contents/MacOS/Other
      `),
    ).toEqual(['222']);
  });
});

describe('launchDesktopApp', () => {
  afterEach(() => {
    execFileMock.mockClear();
    vi.restoreAllMocks();
  });

  it('opens the installed app bundle by path before sending the deep link', async () => {
    const deepLink = 'autopod://connect?url=http%3A%2F%2Flocalhost%3A3100';
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => true) as typeof process.kill);

    await launchDesktopApp(deepLink, { settleMs: 0, launchTimeoutMs: 0 });

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'defaults',
      ['write', 'com.autopod.desktop', 'autopod.pendingDeepLink', deepLink],
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'open',
      ['/Applications/Autopod.app', '--args', deepLink],
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      'pgrep',
      ['-f', '/Applications/Autopod.app/Contents/MacOS/Autopod'],
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      4,
      'ps',
      ['-p', '12345', '-o', 'pid=,stat=,command='],
      expect.any(Function),
    );
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGCONT');
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
