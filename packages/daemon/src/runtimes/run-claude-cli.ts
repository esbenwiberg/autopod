import { spawn } from 'node:child_process';

/**
 * Runs the Claude CLI in print mode, piping `input` via stdin.
 *
 * Uses `spawn` instead of `execFile` so that stdin data is written immediately
 * after the process is created. This avoids the Claude CLI's 3-second stdin
 * timeout that `execFile` can miss when its internal setup delays the write.
 *
 * Also: passing huge prompts (e.g. multi-thousand-line diffs) via argv runs
 * into ARG_MAX. Stdin sidesteps that.
 */
export function runClaudeCli(opts: {
  model: string;
  input: string;
  timeout: number;
  maxBuffer?: number;
}): Promise<{ stdout: string }> {
  const maxBuf = opts.maxBuffer ?? 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const child = spawn('claude', ['-p', '--model', opts.model, '--output-format', 'text']);

    child.stdin.write(opts.input);
    child.stdin.end();
    child.stdin.on('error', () => {});

    let stdout = '';
    let stderr = '';
    let stdoutLen = 0;

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => reject(new Error(`Command timed out after ${opts.timeout}ms`)));
    }, opts.timeout);

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
            new Error(
              `Command failed: claude -p --model ${opts.model} --output-format text\n${stderr}`,
            ),
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
