import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/tui/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['react', 'ink'],
});
