import type { PodRepositoryDisplay } from '@autopod/shared';

/** SQLite extracts only display fields; the full launch/credentials never cross into Node. */
export function repositoryDisplayColumns(table: 'pods' | 'retained_pods'): string {
  return `${table}.launch_config_digest,
    (SELECT CASE WHEN json_valid(s.payload) THEN CASE
      WHEN json_type(s.payload, '$.repository') = 'null' THEN '{"kind":"empty"}'
      WHEN json_type(s.payload, '$.repository.config.remote') = 'text'
        AND length(json_extract(s.payload, '$.repository.config.remote')) <= 2048
        THEN json_object('kind', 'repository', 'remote', json_extract(s.payload, '$.repository.config.remote'))
      ELSE '{"kind":"unavailable"}' END ELSE '{"kind":"unavailable"}' END
    FROM (SELECT pod_id, digest, payload FROM retained_pod_launch_snapshots
      UNION ALL SELECT pod_id, digest, payload FROM pod_launch_phases) s
    WHERE s.pod_id = ${table}.id AND s.digest = ${table}.launch_config_digest
    LIMIT 1) AS display_repository`;
}

export function displayRepository(
  row: Record<string, unknown>,
  legacyRemote?: string,
): PodRepositoryDisplay {
  let remote: unknown = legacyRemote;
  if (row.launch_config_digest) {
    if (typeof row.display_repository !== 'string') return { kind: 'unavailable' };
    const captured = JSON.parse(row.display_repository) as { kind: string; remote?: unknown };
    if (captured.kind === 'empty') return { kind: 'empty' };
    remote = captured.kind === 'repository' ? captured.remote : undefined;
  }
  if (typeof remote !== 'string' || remote.length > 2048) return { kind: 'unavailable' };
  try {
    const normalized = remote.replace(/^([^@]+@[^:]+):([^/].*)$/, 'ssh://$1/$2');
    const url = new URL(normalized);
    if (
      !['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.replaceAll('/', '')
    )
      return { kind: 'unavailable' };
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return { kind: 'repository', remote: url.toString() };
  } catch {
    return { kind: 'unavailable' };
  }
}
