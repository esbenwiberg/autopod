import { AutopodError } from '@autopod/shared';

export const RECOVERY_FILE_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxSelectionBytes: 50 * 1024 * 1024,
  maxFiles: 2000,
  maxVisited: 10000,
  maxDepth: 16,
} as const;
// Conservative convenience browser, NOT a complete archive or a secrets scanner.
export const RECOVERY_FILE_EXCLUDES = [
  '.git',
  'node_modules',
  '.cache',
  '.pnpm-store',
  '.venv',
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.claude',
  '.codex',
  '.env*',
  '.autopod*',
];
export interface RecoveryFileEntry {
  path: string;
  size: number;
  modified: number;
  version: string;
}
export interface RecoveryFileListing {
  files: RecoveryFileEntry[];
  truncated: boolean;
  skippedEntries: number;
}
export interface RecoveryFileContent {
  path: string;
  content: string;
  encoding: 'base64';
  size: number;
  sha256: string;
}
export interface RecoveryFileSource extends RecoveryFileListing {
  id: string;
  kind: 'saved' | 'original';
  label: string;
  binding: string;
  status: 'available' | 'ready' | 'stopped' | 'blocked' | 'unavailable';
  detail: string;
  sandboxId?: string;
}
export interface RecoveryFilesSnapshot {
  version: 1;
  podId: string;
  generation: number;
  sources: RecoveryFileSource[];
  limits: typeof RECOVERY_FILE_LIMITS;
  excludes: string[];
}
export interface RecoveryFileSelection {
  sourceId: string;
  binding: string;
  generation: number;
  path: string;
  version: string;
}
export function recoveryFileError(
  message = 'File selection changed or is unavailable. Refresh files.',
): never {
  throw new AutopodError(message, 'RECOVERY_FILE_UNAVAILABLE', 409);
}
export function safeRecoveryPath(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 1024 &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '\\' || c === ':',
    ) &&
    value
      .split('/')
      .every(
        (s) =>
          s !== '' &&
          s !== '.' &&
          s !== '..' &&
          !RECOVERY_FILE_EXCLUDES.some((x) =>
            x.endsWith('*') ? s.startsWith(x.slice(0, -1)) : s === x,
          ),
      )
  );
}
