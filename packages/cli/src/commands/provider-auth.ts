import { spawn as cpSpawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function extractClaudeOauthToken(output: string): string | null {
  const patterns = [
    /CLAUDE_CODE_OAUTH_TOKEN\s*=\s*['"]?([A-Za-z0-9._~+/=-]{32,})/,
    /(sk-ant-[A-Za-z0-9._=-]{20,})/,
    /^\s*([A-Za-z0-9._~+/=-]{80,})\s*$/m,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return null;
}

export async function runClaudeSetupToken(): Promise<string> {
  const spawnEnv = { ...process.env };
  spawnEnv.ANTHROPIC_API_KEY = undefined;
  spawnEnv.CLAUDE_CODE_OAUTH_TOKEN = undefined;

  return new Promise((resolve, reject) => {
    let output = '';
    const proc = cpSpawn('claude', ['setup-token'], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: spawnEnv,
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      process.stdout.write(chunk);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      process.stderr.write(chunk);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`claude setup-token exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

function spawnInherit(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = cpSpawn(command, args, { stdio: 'inherit', env });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? 'unknown'}`));
      }
    });
  });
}

export async function runOpenAiCodexLogin(): Promise<string> {
  const token = Math.random().toString(36).slice(2, 10);
  const codexHome = path.join(os.tmpdir(), `autopod-codex-auth-${token}`);
  fs.mkdirSync(codexHome, { recursive: true });

  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'OPENAI_API_KEY' && k !== 'CODEX_ACCESS_TOKEN') {
      spawnEnv[k] = v;
    }
  }
  spawnEnv.CODEX_HOME = codexHome;

  try {
    await spawnInherit('codex', ['login', '--device-auth'], spawnEnv);

    const authPath = path.join(codexHome, 'auth.json');
    if (!fs.existsSync(authPath)) {
      throw new Error('No Codex auth.json found. Login may not have completed.');
    }

    const authJson = fs.readFileSync(authPath, 'utf-8');
    JSON.parse(authJson);
    return authJson;
  } finally {
    try {
      fs.rmSync(codexHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export async function runCopilotLogin(): Promise<string> {
  const token = Math.random().toString(36).slice(2, 10);
  const configDir = path.join(os.tmpdir(), `autopod-copilot-auth-${token}`);
  fs.mkdirSync(configDir, { recursive: true });

  const spawnEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      k !== 'COPILOT_GITHUB_TOKEN' &&
      k !== 'GH_TOKEN' &&
      k !== 'GITHUB_TOKEN'
    ) {
      spawnEnv[k] = v;
    }
  }

  try {
    await spawnInherit('copilot', ['login', '--config-dir', configDir], spawnEnv);

    let authToken: string | undefined;
    const credsPath = path.join(configDir, 'github.com.tokens.json');
    if (fs.existsSync(credsPath)) {
      try {
        const credsJson = JSON.parse(fs.readFileSync(credsPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        authToken = typeof credsJson.token === 'string' ? credsJson.token : undefined;
      } catch {
        /* fall through to keychain */
      }
    }

    if (!authToken && process.platform === 'darwin') {
      try {
        authToken =
          execSync('security find-generic-password -s "copilot-cli" -w', {
            encoding: 'utf-8',
            stdio: ['inherit', 'pipe', 'inherit'],
          }).trim() || undefined;
      } catch {
        /* keychain read failed */
      }
    }

    if (!authToken) {
      throw new Error('No Copilot token found. Login may not have completed.');
    }

    return authToken;
  } finally {
    try {
      fs.rmSync(configDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
