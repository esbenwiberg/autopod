import { parseGitHubPrUrl } from './github-url-identity.js';
import { mergeReconciliation } from './merge-source-identity.js';

export function canonicalMergePrIdentity(raw: string): string {
  try {
    if (typeof raw !== 'string' || raw.length > 4096)
      return mergeReconciliation('The durable PR identity is unavailable or unbounded.');
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return mergeReconciliation('A canonical PR address is required for durable merge admission.');
    const path = url.pathname.replace(/\/$/, '');
    if (url.hostname === 'github.com') {
      const pr = parseGitHubPrUrl(raw);
      return `https://github.com/${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}/pull/${pr.number}`;
    }
    const canonical = url.hostname === 'dev.azure.com';
    const match = path.match(
      canonical
        ? /^\/[^/]+\/[^/]+\/_git\/[^/]+\/pullrequest\/([1-9][0-9]*)$/
        : /^\/[^/]+\/_git\/[^/]+\/pullrequest\/([1-9][0-9]*)$/,
    );
    if (!match || !Number.isSafeInteger(Number(match[1])))
      return mergeReconciliation('The durable PR address is not an exact supported pull request.');
    const parts = path.split('/').slice(1).map(decodeURIComponent);
    const legacy = url.hostname.endsWith('.visualstudio.com');
    if (canonical || legacy) {
      const org = canonical ? parts[0] : url.hostname.slice(0, -'.visualstudio.com'.length);
      const project = parts[canonical ? 1 : 0];
      const repository = parts[canonical ? 3 : 2];
      if (
        !org ||
        !project ||
        !repository ||
        [org, project, repository].some((part) => /[\/\\\0\r\n]/.test(part))
      )
        return mergeReconciliation('The durable PR repository path is ambiguous.');
      return `https://dev.azure.com/${encodeURIComponent(org.toLowerCase())}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}/pullrequest/${Number(match[1])}`;
    }
  } catch {
    return mergeReconciliation('The durable PR identity is unsupported.');
  }
  return mergeReconciliation('The durable PR identity is unsupported.');
}
