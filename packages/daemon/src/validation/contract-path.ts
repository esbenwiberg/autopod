/** Canonical spelling used by Fact receipts; not a path-authorization boundary. */
export function normalizeContractPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/^\.\//, '');
}
