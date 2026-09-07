// Prepare a dependency-free Linux check from the actual implementation and test callback.
// This executes that callback through node:test; it does not run the full Vitest suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../../../../..');
const output = process.argv[2];
assert(output, 'Pass a fresh output .mjs path');
const implementationPath = 'packages/daemon/src/containers/docker-container-manager.ts';
const testPath = 'packages/daemon/src/containers/docker-container-manager.test.ts';
const implementation = readFileSync(resolve(root, implementationPath), 'utf8');
const tests = readFileSync(resolve(root, testPath), 'utf8');
const parse = (name, source) => ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
const implementationAst = parse(implementationPath, implementation);
const testAst = parse(testPath, tests);
const functions = implementationAst.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'terminateStreamingProcessGroupScript',
);
assert.equal(functions.length, 1);
const name = 'terminates a surviving child in the dedicated streaming process group';
const callbacks = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === name) {
    assert.equal(node.expression.expression?.getText(testAst), 'it.skipIf');
    assert.equal(node.expression.arguments[0]?.getText(testAst), "process.platform !== 'linux'");
    assert(ts.isArrowFunction(node.arguments[1]));
    callbacks.push(node.arguments[1].getText(testAst));
  }
  ts.forEachChild(node, visit);
}
visit(testAst);
assert.equal(callbacks.length, 1);
const callback = callbacks[0];
// Fail if the source oracle changes beyond the two assertion forms supported below.
assert.deepEqual(
  [...callback.matchAll(/expect\([^\n]+?\)\.([\w]+)\(/g)].map((match) => match[1]),
  ['toBeGreaterThan', 'toBe'],
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const sourceStatus = execFileSync(
  'git',
  ['status', '--porcelain', '--', implementationPath, testPath],
  {
    cwd: root,
    encoding: 'utf8',
  },
).trim();
assert.equal(
  sourceStatus,
  '',
  'Commit the tested implementation and oracle before preparing proof',
);
const metadata = {
  sourceHead,
  sourceStatus,
  implementationPath,
  implementationSha256: hash(implementation),
  testPath,
  testSha256: hash(tests),
  callbackSha256: hash(callback),
  proofScope:
    'Exact extracted regression callback and implementation function via node:test on Linux',
};
const source = `
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
assert.equal(process.platform, 'linux');
console.log(JSON.stringify({ ...${JSON.stringify(metadata)}, runtime: process.version, platform: process.platform, architecture: process.arch }));
const expect = (actual) => ({
  toBeGreaterThan: (expected) => assert.ok(actual > expected),
  toBe: (expected) => assert.equal(actual, expected),
});
${functions[0].getText(implementationAst)}
test(${JSON.stringify(name)}, { timeout: 10000 }, ${callback});
`;
const result = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
});
assert.equal(result.diagnostics.length, 0);
writeFileSync(output, result.outputText, { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({ ...metadata, generatedSha256: hash(result.outputText), output }, null, 2),
);
