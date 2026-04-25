import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gatherReviewContext, parseDiffFilePaths } from './review-context-builder.js';

const execFileAsync = promisify(execFile);

// ── parseDiffFilePaths ────────────────────────────────────────────────────────

describe('parseDiffFilePaths', () => {
  it('extracts file paths from unified diff headers', () => {
    const diff = `
diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { foo } from './foo';
+import { bar } from './bar';
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
`;
    const paths = parseDiffFilePaths(diff);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('package.json');
  });

  it('handles new files (--- /dev/null)', () => {
    const diff = `
diff --git a/new-file.ts b/new-file.ts
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,5 @@
+console.log('hello');
`;
    const paths = parseDiffFilePaths(diff);
    expect(paths).toContain('new-file.ts');
    expect(paths).not.toContain('/dev/null');
  });

  it('handles deleted files (+++ /dev/null)', () => {
    const diff = `
diff --git a/old-file.ts b/old-file.ts
--- a/old-file.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-console.log('goodbye');
`;
    const paths = parseDiffFilePaths(diff);
    expect(paths).toContain('old-file.ts');
  });

  it('returns empty array for empty diff', () => {
    expect(parseDiffFilePaths('')).toEqual([]);
  });

  it('deduplicates paths', () => {
    const diff = `
--- a/foo.ts
+++ b/foo.ts
`;
    const paths = parseDiffFilePaths(diff);
    // foo.ts appears in both --- and +++ but should only be listed once
    expect(paths.filter((p) => p === 'foo.ts')).toHaveLength(1);
  });
});

// ── gatherReviewContext (integration with real git) ───────────────────────────

describe('gatherReviewContext', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-ctx-'));
    // Init a git repo
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    // Disable commit/tag signing locally so tests don't depend on the host's
    // global gpg.format / gpg.ssh.program configuration.
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
    await execFileAsync('git', ['config', 'tag.gpgsign', 'false'], { cwd: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects gitignore violations', async () => {
    // Create a file, commit it, then add it to .gitignore
    await fs.writeFile(path.join(tmpDir, 'build-output.js'), 'console.log("build");');
    await execFileAsync('git', ['add', 'build-output.js'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'add build output'], { cwd: tmpDir });
    const { stdout: startCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpDir,
    });

    // Add .gitignore that would ignore the file
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'build-output.js\n');
    await execFileAsync('git', ['add', '.gitignore'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'add gitignore'], { cwd: tmpDir });

    // Build a diff that includes the file
    const diff = `
--- /dev/null
+++ b/build-output.js
@@ -0,0 +1 @@
+console.log("build");
--- /dev/null
+++ b/.gitignore
@@ -0,0 +1 @@
+build-output.js
`;

    const ctx = await gatherReviewContext(tmpDir, diff, startCommit.trim());

    // Should detect the violation
    const violation = ctx.annotations.find((a) => a.includes('GITIGNORE VIOLATION'));
    expect(violation).toBeDefined();
    expect(violation).toContain('build-output.js');
  });

  it('returns git status summary', async () => {
    // Create an initial commit so git status works
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    // Create an uncommitted file
    await fs.writeFile(path.join(tmpDir, 'uncommitted.ts'), 'export const x = 1;');

    const ctx = await gatherReviewContext(tmpDir, '');

    expect(ctx.gitStatusSummary).toContain('uncommitted.ts');
  });

  it('returns clean status for committed repo', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const ctx = await gatherReviewContext(tmpDir, '');

    expect(ctx.gitStatusSummary).toContain('clean');
  });

  it('returns file tree summary', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'src/index.ts'), 'export {};');
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const ctx = await gatherReviewContext(tmpDir, '');

    expect(ctx.fileTreeSummary).toContain('2 files total');
    expect(ctx.fileTreeSummary).toContain('src/');
  });

  it('includes .gitignore in supplementary files', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitignore'), 'node_modules\n*.log\n');
    await fs.writeFile(path.join(tmpDir, 'index.ts'), 'export {};');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const ctx = await gatherReviewContext(tmpDir, '');

    const gitignore = ctx.supplementaryFiles.find((f) => f.path === '.gitignore');
    expect(gitignore).toBeDefined();
    expect(gitignore?.content).toContain('node_modules');
  });

  it('includes config files touched by the diff', async () => {
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name": "test"}');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const diff = `
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"name": "test"}
+{"name": "test", "version": "1.0.0"}
`;

    const ctx = await gatherReviewContext(tmpDir, diff);

    const pkg = ctx.supplementaryFiles.find((f) => f.path === 'package.json');
    expect(pkg).toBeDefined();
    expect(pkg?.reason).toContain('config file modified in this diff');
  });

  it('detects contradictory ops across commits', async () => {
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# init');
    await execFileAsync('git', ['add', '.'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
    const { stdout: startCommit } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpDir,
    });

    // Add a file
    await fs.writeFile(path.join(tmpDir, 'temp.txt'), 'temporary');
    await execFileAsync('git', ['add', 'temp.txt'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'add temp'], { cwd: tmpDir });

    // Delete it
    await execFileAsync('git', ['rm', 'temp.txt'], { cwd: tmpDir });
    await execFileAsync('git', ['commit', '-m', 'remove temp'], { cwd: tmpDir });

    const ctx = await gatherReviewContext(tmpDir, '', startCommit.trim());

    const contradiction = ctx.annotations.find((a) => a.includes('temp.txt'));
    expect(contradiction).toBeDefined();
    expect(contradiction).toContain('added');
    expect(contradiction).toContain('deleted');
  });

  it('handles empty repo gracefully', async () => {
    // Empty repo with no commits — gatherReviewContext should not throw
    const ctx = await gatherReviewContext(tmpDir, '');

    expect(ctx.annotations).toEqual([]);
    expect(ctx.supplementaryFiles).toEqual([]);
  });
});
