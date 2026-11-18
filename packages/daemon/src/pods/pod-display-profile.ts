import type { PodProfileDisplay } from '@autopod/shared';

/** Project only bounded, credential-free labels from the digest-bound launch snapshot. */
export function profileDisplayColumns(table: 'pods' | 'retained_pods'): string {
  return `(SELECT CASE WHEN json_valid(s.payload) THEN
    (SELECT json_object('id', json_extract(s.payload, '$.profileId'), 'name', r.value ->> '$.name')
      FROM json_each(CASE WHEN json_type(s.payload, '$.revisions') = 'array'
        THEN json_extract(s.payload, '$.revisions') ELSE '[]' END) r
      WHERE json_type(s.payload, '$.profileId') = 'text'
        AND length(CAST(json_extract(s.payload, '$.profileId') AS BLOB)) BETWEEN 1 AND 128
        AND instr(json_extract(s.payload, '$.profileId'), char(0)) = 0
        AND CASE WHEN r.type = 'object' THEN
          r.value ->> '$.id' = json_extract(s.payload, '$.profileId')
          AND r.value ->> '$.kind' = 'profile'
          AND json_type(r.value, '$.name') = 'text'
          AND length(r.value ->> '$.name') BETWEEN 1 AND 128
          AND length(CAST(r.value ->> '$.name' AS BLOB)) BETWEEN 1 AND 512
          AND instr(r.value ->> '$.name', char(0)) = 0
          AND length(trim(r.value ->> '$.name')) > 0
        ELSE 0 END
      LIMIT 1) END
    FROM (SELECT pod_id, digest, payload FROM retained_pod_launch_snapshots
      UNION ALL SELECT pod_id, digest, payload FROM pod_launch_phases) s
    WHERE s.pod_id = ${table}.id AND s.digest = ${table}.launch_config_digest
    LIMIT 1) AS display_profile,
    (SELECT CASE WHEN e.archived = 1 THEN 'archived' ELSE 'active' END
      FROM configuration_entities e
      WHERE e.kind = 'profile' AND e.id = ${table}.profile_name) AS display_profile_state`;
}

export function displayProfile(row: Record<string, unknown>): PodProfileDisplay {
  const identity = typeof row.profile_name === 'string' ? row.profile_name : null;
  if (!row.launch_config_digest) return { id: null, name: identity, state: 'legacy' };
  if (typeof row.display_profile === 'string') {
    const captured = JSON.parse(row.display_profile) as { id: string; name: string };
    if (captured.id === identity) {
      return {
        ...captured,
        state:
          row.display_profile_state === 'active' || row.display_profile_state === 'archived'
            ? row.display_profile_state
            : 'deleted',
      };
    }
  }
  return { id: identity, name: null, state: 'unavailable' };
}
