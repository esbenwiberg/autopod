import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('watcher declarations retain exact refined schema types without expanding launch schemas', () => {
  const directory = resolve(root, 'packages/shared/src/schemas');
  const source = resolve(directory, 'issue-watcher-binding.schema.ts');
  const fixture = resolve(directory, '__watcher-declaration-proof.ts');
  const proof = `
import { z } from 'zod';
import { savedLaunchSelectionSchema } from './launch-config.schema.js';
import { issueWatcherBindingSchema } from './issue-watcher-binding.schema.js';
const inferred = savedLaunchSelectionSchema.refine(
  (value): value is Extract<z.infer<typeof savedLaunchSelectionSchema>, { repositoryId: string }> =>
    'repositoryId' in value && !!value.repositoryId,
);
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type ExactSchema = Expect<Equal<typeof inferred, typeof issueWatcherBindingSchema.shape.launch>>;
export type ExactInput = Expect<Equal<z.input<typeof inferred>, z.input<typeof issueWatcherBindingSchema.shape.launch>>>;
export type ExactOutput = Expect<Equal<z.output<typeof inferred>, z.output<typeof issueWatcherBindingSchema.shape.launch>>>;
`;
  const configPath = resolve(root, 'packages/shared/tsconfig.json');
  const config = ts.parseJsonConfigFileContent(
    ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8')).config,
    ts.sys,
    dirname(configPath),
  );
  const options = {
    ...config.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...rest) =>
    path === fixture
      ? ts.createSourceFile(path, proof, languageVersion, true)
      : getSourceFile(path, languageVersion, ...rest);
  const program = ts.createProgram([source, fixture], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
  let declaration = '';
  const emitted = program.emit(program.getSourceFile(source), (path, text) => {
    if (path.endsWith('.d.ts')) declaration = text;
  });
  assert.equal(emitted.emitSkipped, false);
  assert.ok(declaration.length > 0);
  // This module references launch schemas; serializing them repeatedly was >600 KB.
  assert.ok(
    declaration.length < 20_000,
    `Watcher declaration expanded to ${declaration.length} bytes`,
  );
});
