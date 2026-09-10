import { AutopodError } from '@autopod/shared';

function invalidIdentity(): never {
  throw new AutopodError(
    'GitHub address does not identify an exact supported repository or pull request. Reconcile delivery before retrying.',
    'DELIVERY_RECONCILIATION_REQUIRED',
    409,
  );
}
function segment(value: string | undefined): string {
  if (!value) return invalidIdentity();
  const decoded = decodeURIComponent(value);
  if (!/^[a-zA-Z0-9_.-]+$/.test(decoded) || decoded === '.' || decoded === '..')
    return invalidIdentity();
  return decoded;
}
function address(raw: string, repository: boolean): URL {
  const scp = repository && raw.match(/^git@github\.com:([^\s]+)$/);
  const url = new URL(scp ? `ssh://git@github.com/${scp[1]}` : raw);
  if (
    url.hostname !== 'github.com' ||
    (url.password && !(repository && url.protocol === 'https:')) ||
    (url.protocol !== 'https:' &&
      !(repository && url.protocol === 'ssh:' && url.username === 'git')) ||
    (url.username &&
      !(
        repository &&
        (url.protocol === 'https:' || (url.protocol === 'ssh:' && url.username === 'git'))
      )) ||
    (url.port && !(repository && url.protocol === 'ssh:' && url.port === '22'))
  )
    return invalidIdentity();
  return url;
}

export function parseGitHubRepoUrl(raw: string): { owner: string; repo: string } {
  try {
    const url = address(raw, true);
    if (url.search || url.hash) return invalidIdentity();
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
    if (!match) return invalidIdentity();
    return { owner: segment(match[1]), repo: segment(match[2]?.replace(/\.git$/, '')) };
  } catch {
    return invalidIdentity();
  }
}

export function parseGitHubPrUrl(raw: string): { owner: string; repo: string; number: number } {
  try {
    const url = address(raw, false);
    const match = url.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)(?:\/(?:files|commits|checks))?\/?$/,
    );
    if (!match || !Number.isSafeInteger(Number(match[3]))) return invalidIdentity();
    return { owner: segment(match[1]), repo: segment(match[2]), number: Number(match[3]) };
  } catch {
    return invalidIdentity();
  }
}
