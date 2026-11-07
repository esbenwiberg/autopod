import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'packages/shared/src/schemas/launch-config.schema.ts');
const original = readFileSync(source, 'utf8');
const ast = ts.createSourceFile(source, original, ts.ScriptTarget.Latest, true);
const schemas = ['savedLaunchSelectionSchema', 'launchRequestSchema'];

// Re-infer the actual initializers without their public annotations. This checks
// the complete Zod API (not just assignability of the parsed wire values).
const inferred = schemas.map((name) => {
  const declaration = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((declaration) => declaration.name.getText(ast) === name);
  assert.ok(declaration?.type, `${name} must retain an explicit declaration boundary`);
  return `const inferred_${name} = ${declaration.initializer.getText(ast)};`;
});
const proof = `
${inferred.join('\n')}
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
${schemas
  .map(
    (name) => `
export type Exact_${name} = [
  Expect<Equal<typeof ${name}, typeof inferred_${name}>>,
  Expect<Equal<z.input<typeof ${name}>, z.input<typeof inferred_${name}>>>,
  Expect<Equal<z.output<typeof ${name}>, z.output<typeof inferred_${name}>>>
];`,
  )
  .join('\n')}
type RequestInput = z.input<typeof launchRequestSchema>;
type RequestOutput = z.output<typeof launchRequestSchema>;
export type NegativeAndDefaultChecks = [
  Expect<Equal<{ emptyWorkspace: true; task: string } extends RequestInput ? true : false, false>>,
  Expect<Equal<{ repositoryId: string } extends RequestInput ? true : false, false>>,
  Expect<Equal<Extract<RequestInput, { emptyWorkspace: true }>['profileId'], string>>,
  Expect<Equal<Extract<RequestInput, { repositoryId: string }>['repositorySetupId'], string | undefined>>,
  Expect<Equal<undefined extends RequestInput['referenceRepositories'] ? true : false, true>>,
  Expect<Equal<undefined extends RequestOutput['referenceRepositories'] ? true : false, false>>,
  Expect<Equal<'task' extends keyof z.input<typeof savedLaunchSelectionSchema> ? true : false, false>>,
  Expect<Equal<'work' extends keyof z.input<typeof savedLaunchSelectionSchema> ? true : false, false>>
];
`;

function compile(extra = '') {
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
    path === source
      ? ts.createSourceFile(path, original + extra, languageVersion, true)
      : getSourceFile(path, languageVersion, ...rest);
  const program = ts.createProgram([source], options, host);
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
  return program;
}

test('named launch boundaries exactly preserve inferred schema, input, output and negative types', () => {
  compile(proof);
});

test('launch union declarations reference named shapes instead of serializing each arm', () => {
  const program = compile();
  let declaration = '';
  const emitted = program.emit(program.getSourceFile(source), (path, text) => {
    if (path.endsWith('.d.ts')) declaration = text;
  });
  assert.equal(emitted.emitSkipped, false);
  assert.ok(declaration.length > 0);
  const emittedAst = ts.createSourceFile(source, declaration, ts.ScriptTarget.Latest, true);
  for (const name of schemas) {
    const statement = emittedAst.statements.find(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some(
          (item) => item.name.getText(emittedAst) === name,
        ),
    );
    assert.ok(statement, name);
    assert.ok(
      statement.getFullWidth() < 200,
      `${name} expanded to ${statement.getFullWidth()} characters`,
    );
  }
  // Baseline launch-config declarations were >205 KB, including repeated union arms.
  assert.ok(
    declaration.length < 175_000,
    `Launch declarations expanded to ${declaration.length} characters`,
  );
});
