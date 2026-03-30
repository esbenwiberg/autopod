/** Persisted connection config stored in localStorage. */

const KEY = 'autopod:config';

export interface StoredConfig {
  baseUrl: string;
  /** Only set in dev mode (token-paste flow). In prod, MSAL manages the token. */
  devToken?: string;
}

export function loadConfig(): StoredConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: StoredConfig): void {
  localStorage.setItem(KEY, JSON.stringify(config));
}

export function clearConfig(): void {
  localStorage.removeItem(KEY);
}
