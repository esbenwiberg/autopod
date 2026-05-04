import { spawn } from 'node:child_process';

export interface AgenticReviewConfig {
  model: string;
  prompt: string;
  worktreePath: string;
  timeout: number;
}

/**
 * Tier 3: Runs a review using the `claude` CLI in agentic mode with
 * read-only tool access scoped to the worktree directory.
 *
 * The reviewer gets access to Bash (read-only git commands), Read, and Grep
 * tools, but cannot edit files or run arbitrary commands.
 */
export async function runAgenticReview(config: AgenticReviewConfig): Promise<{ stdout: string }> {
  const maxBuf = 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const child = spawn(
      'claude',
      [
        '-p',
        '--model',
        config.model,
        '--output-format',
        'text',
        '--allowedTools',
        'Read',
        'Bash(git log:*)',
        'Bash(git status:*)',
        'Bash(git show:*)',
        'Bash(git ls-files:*)',
        'Bash(git check-ignore:*)',
        'Bash(git diff:*)',
        '--add-dir',
        config.worktreePath,
        '--system-prompt',
        'You are an expert code reviewer with read-only access to the repository for VERIFYING claims in the diff. ' +
          'Use the tools to confirm or refute specific things the diff is doing — not to discover unrelated issues. ' +
          'HARD RULE — every issue you raise MUST cite a file path that appears as a header in the DIFF section ' +
          '(`+++ b/<path>` or `--- a/<path>`). If a file is not in the DIFF, Read it ONLY for context — never to flag ' +
          'a new issue in it. Findings citing only paths outside the diff are automatically discarded by the harness. ' +
          'CRITICAL: Untracked files (lines starting with `??` in git status) are NOT part of this PR — ' +
          'they are leftover worktree state from build artifacts, tooling, or prior pod runs. ' +
          "Do not flag, cite, or read untracked files unless investigating a `.gitignore` violation explicitly listed under the prompt's Warnings section. " +
          'When done investigating, output ONLY a JSON object with your review verdict. ' +
          'Do not wrap the JSON in markdown fences. ' +
          'The JSON must have: "status" ("pass"|"fail"|"uncertain"), "reasoning" (string), "issues" (string[]).',
      ],
      {
        cwd: config.worktreePath,
        env: {
          ...process.env,
          // Prevent interactive prompts
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
        },
      },
    );

    // Write the review prompt to stdin immediately
    child.stdin.write(config.prompt);
    child.stdin.end();
    child.stdin.on('error', () => {});

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new Error(`Tier 3 agentic review timed out after ${config.timeout}ms`)));
    }, config.timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuf) {
        child.kill('SIGTERM');
        settle(() => reject(new Error(`stdout exceeded maxBuffer (${maxBuf} bytes)`)));
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        settle(() =>
          reject(
            new Error(`Tier 3 agentic review failed (exit ${code}):\n${stderr.slice(0, 1000)}`),
          ),
        );
      } else {
        settle(() => resolve({ stdout }));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
  });
}
