import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ['node-pty'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
