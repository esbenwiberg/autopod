import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeConfigInstallCommand } from './runtime-config-capability.js';

describe.skipIf(process.getuid?.() === 0)(
  'sandbox config with actual non-root exec and no chown capability',
  () => {
    const directories: string[] = [];
    afterEach(() => {
      for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    function fixture() {
      const dir = mkdtempSync(join(tmpdir(), 'autopod-config-capability-'));
      directories.push(dir);
      const source = join(dir, 'uploaded config.toml');
      const target = join(dir, 'config.toml');
      writeFileSync(source, 'model_reasoning_effort = "high"\n');
      writeFileSync(target, 'old');
      chmodSync(target, 0o444);
      const deniedChown = join(dir, 'chown');
      writeFileSync(deniedChown, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
      return { dir, source, target };
    }
    function install(source: string, target: string, dir: string) {
      const [command, ...args] = runtimeConfigInstallCommand(source, target);
      if (!command) throw new Error('Missing install command');
      return execFileSync(command, args, {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        stdio: 'pipe',
      });
    }
    it('replaces a read-only upload target without chown and remains safe to repeat', () => {
      const { source, target, dir } = fixture();
      install(source, target, dir);
      install(source, target, dir);
      expect(readFileSync(target, 'utf8')).toBe(readFileSync(source, 'utf8'));
      expect(statSync(target).mode & 0o777).toBe(0o644);
      expect(statSync(target).uid).toBe(process.getuid?.());
    });
    it('fails without replacing the previous config when the upload is unreadable', () => {
      const { source, target, dir } = fixture();
      chmodSync(source, 0o000);
      expect(() => install(source, target, dir)).toThrow();
      expect(readFileSync(target, 'utf8')).toBe('old');
    });
    it('rejects a symlink target without modifying the linked file', () => {
      const { source, target, dir } = fixture();
      rmSync(target);
      symlinkSync(source, target);
      expect(() => install(source, target, dir)).toThrow();
      expect(readFileSync(source, 'utf8')).toContain('high');
    });
  },
);
