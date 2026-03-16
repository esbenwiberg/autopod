import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock os.homedir to use a temp directory
const tmpDir = path.join(os.tmpdir(), `autopod-test-${Date.now()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

// Import after mocking
const { getAll, get, set, setAll, getConfigPath } = await import('./config-store.js');

describe('ConfigStore', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = getAll();
    expect(config.daemon).toBe('http://localhost:3100');
  });

  it('writes and reads a config value', () => {
    set('daemon', 'http://example.com:3200');
    expect(get('daemon')).toBe('http://example.com:3200');
  });

  it('writes and reads full config', () => {
    const config = {
      daemon: 'http://example.com:3200',
      defaultModel: 'sonnet',
      watch: { theme: 'light' as const, refreshInterval: 1000 },
    };
    setAll(config);
    const result = getAll();
    expect(result.daemon).toBe('http://example.com:3200');
    expect(result.defaultModel).toBe('sonnet');
    expect(result.watch?.theme).toBe('light');
  });

  it('falls back to defaults on invalid config', () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, 'daemon: not-a-url\n', 'utf-8');
    const config = getAll();
    // Invalid URL means validation fails, so we get defaults
    expect(config.daemon).toBe('http://localhost:3100');
  });

  it('creates config directory if it does not exist', () => {
    set('defaultModel', 'opus');
    expect(fs.existsSync(path.join(tmpDir, '.autopod'))).toBe(true);
  });

  it('rejects invalid config via setAll', () => {
    expect(() =>
      setAll({ daemon: 'not-a-url' }),
    ).toThrow();
  });
});
