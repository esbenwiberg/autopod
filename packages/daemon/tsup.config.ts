import { cpSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['better-sqlite3', 'pino-pretty'],
  onSuccess: async () => {
    mkdirSync('dist/db/migrations', { recursive: true });
    cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
    mkdirSync('dist/actions/defaults', { recursive: true });
    cpSync('src/actions/defaults', 'dist/actions/defaults', { recursive: true });
    mkdirSync('dist/containers', { recursive: true });
    cpSync('src/containers/seccomp-profile.json', 'dist/containers/seccomp-profile.json');
    mkdirSync('dist/images', { recursive: true });
    cpSync('src/images/image-digests.json', 'dist/images/image-digests.json');
    cpSync('src/images/dagger-cli-version.json', 'dist/images/dagger-cli-version.json');
  },
});
