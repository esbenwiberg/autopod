import type { ReferenceRepo } from '@autopod/shared';

function deriveMountName(url: string): string {
  const last = url
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .pop();
  return last && last.length > 0 ? last : url;
}

export function deriveReferenceRepos(
  requested: ReadonlyArray<{ url: string }> | undefined | null,
): ReferenceRepo[] {
  if (!requested?.length) return [];
  const used = new Set<string>();
  const result: ReferenceRepo[] = [];
  for (const r of requested) {
    const base = deriveMountName(r.url);
    let mountPath = base;
    let suffix = 2;
    while (used.has(mountPath)) {
      mountPath = `${base}-${suffix}`;
      suffix++;
    }
    used.add(mountPath);
    result.push({ url: r.url, mountPath });
  }
  return result;
}
