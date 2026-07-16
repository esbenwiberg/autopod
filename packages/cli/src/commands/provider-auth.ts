import { spawn as cpSpawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PiOAuthProviderId, ProviderCredentials } from '@autopod/shared';

const PI_OAUTH_PROVIDER_IDS = ['anthropic', 'openai-codex', 'github-copilot'] as const;

export function isPiOAuthProviderId(value: string): value is PiOAuthProviderId {
  return PI_OAUTH_PROVIDER_IDS.includes(value as PiOAuthProviderId);
}

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

function buildIsolatedEnv(blockedKeys: string[]): Record<string, string> {
  const blocked = new Set(blockedKeys);
  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !blocked.has(key)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

export async function runOpenAiCodexLogin(): Promise<string> {
  const token = Math.random().toString(36).slice(2, 10);
  const codexHome = path.join(os.tmpdir(), `autopod-codex-auth-${token}`);
  fs.mkdirSync(codexHome, { recursive: true });

  const spawnEnv = buildIsolatedEnv(['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']);
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

  const spawnEnv = buildIsolatedEnv(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);

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

export function extractPiCredential(
  authJson: string,
  providerId: PiOAuthProviderId,
): ProviderCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson);
  } catch {
    throw new Error('Pi auth.json was not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pi auth.json must contain a provider credential object.');
  }

  const entries = parsed as Record<string, unknown>;
  const selected = entries[providerId];
  if (!selected) {
    throw new Error(`Pi auth.json did not contain credentials for provider "${providerId}".`);
  }
  if (
    typeof selected !== 'object' ||
    Array.isArray(selected) ||
    !hasNonEmptyPiAccessCredential(selected as Record<string, unknown>)
  ) {
    throw new Error(`Pi credential for provider "${providerId}" was malformed.`);
  }

  return {
    provider: 'pi',
    providerId,
    credential: selected as Record<string, unknown>,
  };
}

function hasNonEmptyPiAccessCredential(credential: Record<string, unknown>): boolean {
  return ['access', 'accessToken', 'token'].some(
    (field) => typeof credential[field] === 'string' && credential[field].trim().length > 0,
  );
}

export async function runPiLogin(providerId: PiOAuthProviderId): Promise<ProviderCredentials> {
  const piAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-pi-auth-'));
  fs.chmodSync(piAgentDir, 0o700);

  const spawnEnv = buildIsolatedEnv([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ]);
  spawnEnv.PI_CODING_AGENT_DIR = piAgentDir;

  try {
    try {
      await spawnInherit('pi', ['/login'], spawnEnv);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'Pi CLI not found. Install @earendil-works/pi-coding-agent@0.80.6 and retry.',
        );
      }
      throw error;
    }

    const authPath = path.join(piAgentDir, 'auth.json');
    if (!fs.existsSync(authPath)) {
      throw new Error('No Pi auth.json found. Login may not have completed.');
    }

    return extractPiCredential(fs.readFileSync(authPath, 'utf-8'), providerId);
  } finally {
    fs.rmSync(piAgentDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
}
