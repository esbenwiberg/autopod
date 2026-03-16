import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'yaml';
import { configSchema, DEFAULT_CONFIG, type CliConfig } from './schema.js';

const CONFIG_DIR = path.join(os.homedir(), '.autopod');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.yaml');

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function getAll(): CliConfig {
  ensureDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed: unknown = parse(raw);
    const result = configSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`Warning: Invalid config at ${CONFIG_PATH}, using defaults`);
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...result.data };
  } catch {
    console.warn(`Warning: Could not read config at ${CONFIG_PATH}, using defaults`);
    return { ...DEFAULT_CONFIG };
  }
}

export function get<K extends keyof CliConfig>(key: K): CliConfig[K] {
  return getAll()[key];
}

export function set<K extends keyof CliConfig>(key: K, value: CliConfig[K]): void {
  ensureDir();
  const current = getAll();
  current[key] = value;
  fs.writeFileSync(CONFIG_PATH, stringify(current), 'utf-8');
}

export function setAll(config: CliConfig): void {
  ensureDir();
  const result = configSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }
  fs.writeFileSync(CONFIG_PATH, stringify(result.data), 'utf-8');
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
