import { randomUUID } from 'node:crypto';
import {
  AutopodError,
  type ConfigurationEntity,
  type ConfigurationKind,
  type ConfigurationPayloads,
  type ConfigurationRevision,
  configurationPayloadSchemas,
  configurationRevisionSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface ConfigurationWrite {
  id?: string;
  kind: ConfigurationKind;
  name: string;
  payload: unknown;
  expectedRevision?: number;
}
export interface ConfigurationStore {
  get<K extends ConfigurationKind>(kind: K, id: string, revision?: number): ConfigurationEntity<K>;
  list<K extends ConfigurationKind>(kind: K, includeArchived?: boolean): ConfigurationEntity<K>[];
  write(input: ConfigurationWrite): ConfigurationEntity;
  writeBatch(inputs: ConfigurationWrite[]): ConfigurationEntity[];
  archive(kind: ConfigurationKind, id: string, expectedRevision: number): void;
  assertCurrent(revisions: ConfigurationRevision[]): void;
}
interface EntityRow {
  id: string;
  kind: ConfigurationKind;
  name: string;
  revision: number;
  archived: number;
  created_at: string;
  updated_at: string;
  payload: string;
}
export function configurationError(
  message: string,
  code = 'INVALID_CONFIGURATION',
  status = 400,
): never {
  throw new AutopodError(message, code, status);
}
export function parseConfigurationPayload<K extends ConfigurationKind>(
  kind: K,
  raw: unknown,
): ConfigurationPayloads[K] {
  // The lookup key determines the schema; the cast preserves that correlation for callers.
  return configurationPayloadSchemas[kind].parse(raw) as ConfigurationPayloads[K];
}
function hydrate<K extends ConfigurationKind>(row: EntityRow, kind: K): ConfigurationEntity<K> {
  return {
    ...configurationRevisionSchema.parse({
      id: row.id,
      kind,
      name: row.name,
      revision: row.revision,
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
    kind,
    payload: parseConfigurationPayload(kind, JSON.parse(row.payload)),
  } as ConfigurationEntity<K>;
}
function references(entity: ConfigurationEntity): Array<{ kind: ConfigurationKind; id: string }> {
  if (entity.kind === 'repository') {
    return entity.payload.usualProfileId
      ? [{ kind: 'profile', id: entity.payload.usualProfileId }]
      : [];
  }
  if (entity.kind !== 'profile') return [];
  const p = entity.payload;
  return [
    { kind: 'environment', id: p.environmentId },
    { kind: 'ai', id: p.aiId },
    { kind: 'workflow', id: p.workflowId },
    ...(p.githubAccessId ? [{ kind: 'githubAccess' as const, id: p.githubAccessId }] : []),
    ...p.toolPackIds.map((id) => ({ kind: 'toolPack' as const, id })),
    ...(p.workerProfileId ? [{ kind: 'profile' as const, id: p.workerProfileId }] : []),
  ];
}

export function createConfigurationStore(db: Database.Database): ConfigurationStore {
  const select = db.prepare(`SELECT e.id,e.kind,r.name,r.revision,e.archived,e.created_at,
    r.created_at AS updated_at,r.payload FROM configuration_entities e
    JOIN configuration_revisions r ON r.entity_id=e.id
    AND r.revision=COALESCE(@revision,e.revision) WHERE e.id=@id AND e.kind=@kind`);
  const store: ConfigurationStore = {
    get(kind, id, revision) {
      const row = select.get({ kind, id, revision: revision ?? null }) as EntityRow | undefined;
      if (!row)
        configurationError(`Configuration ${kind}/${id} not found`, 'CONFIG_NOT_FOUND', 404);
      if (revision === undefined && row.archived)
        configurationError(`Configuration ${kind}/${id} is archived`, 'CONFIG_ARCHIVED', 409);
      return hydrate(row, kind);
    },
    list(kind, includeArchived = false) {
      const rows = db
        .prepare(`SELECT e.id,e.kind,r.name,r.revision,e.archived,e.created_at,
        r.created_at AS updated_at,r.payload FROM configuration_entities e
        JOIN configuration_revisions r ON r.entity_id=e.id AND r.revision=e.revision
        WHERE e.kind=? AND (? OR e.archived=0) ORDER BY e.name,e.id`)
        .all(kind, Number(includeArchived)) as EntityRow[];
      return rows.map((row) => hydrate(row, kind));
    },
    write(input) {
      return store.writeBatch([input])[0] as ConfigurationEntity;
    },
    writeBatch(inputs) {
      return db.transaction(() => {
        const pending = inputs.map((input) => {
          const id = input.id ?? randomUUID();
          const existing = db
            .prepare('SELECT kind,revision,archived FROM configuration_entities WHERE id=?')
            .get(id) as { kind: ConfigurationKind; revision: number; archived: number } | undefined;
          if (
            existing &&
            (existing.kind !== input.kind ||
              existing.archived ||
              existing.revision !== input.expectedRevision)
          ) {
            configurationError(
              'Configuration changed; refresh before saving',
              'CONFIG_CHANGED',
              409,
            );
          }
          if (!existing && input.expectedRevision !== undefined)
            configurationError('Configuration no longer exists', 'CONFIG_CHANGED', 409);
          const now = new Date().toISOString();
          const entity = {
            ...configurationRevisionSchema.parse({
              id,
              kind: input.kind,
              name: input.name,
              revision: (existing?.revision ?? 0) + 1,
              createdAt: now,
              updatedAt: now,
              archived: false,
            }),
            payload: parseConfigurationPayload(input.kind, input.payload),
          } as ConfigurationEntity;
          return { entity, existing };
        });
        const batch = new Map(pending.map(({ entity }) => [entity.id, entity]));
        if (batch.size !== pending.length)
          configurationError('Duplicate entity in configuration batch');
        const lookup = (kind: ConfigurationKind, id: string): ConfigurationEntity => {
          const entity = batch.get(id) ?? store.get(kind, id);
          if (entity.kind !== kind) configurationError(`Wrong configuration kind for ${id}`);
          return entity;
        };
        for (const { entity } of pending) {
          for (const ref of references(entity)) lookup(ref.kind, ref.id);
          if (entity.kind === 'profile') {
            const seen = new Set<string>([entity.id]);
            let worker = entity.payload.workerProfileId;
            while (worker) {
              if (seen.has(worker))
                configurationError('Worker profiles form a cycle', 'WORKER_PROFILE_CYCLE');
              seen.add(worker);
              const next = lookup('profile', worker);
              worker = next.kind === 'profile' ? next.payload.workerProfileId : null;
            }
          }
        }
        for (const { entity, existing } of pending) {
          const duplicate = db
            .prepare('SELECT id FROM configuration_entities WHERE kind=? AND name=? AND id<>?')
            .get(entity.kind, entity.name, entity.id);
          if (duplicate)
            configurationError('Configuration name already exists', 'CONFIG_NAME_EXISTS', 409);
          if (existing)
            db.prepare(
              'UPDATE configuration_entities SET name=?,revision=?,updated_at=? WHERE id=?',
            ).run(entity.name, entity.revision, entity.updatedAt, entity.id);
          else
            db.prepare(
              'INSERT INTO configuration_entities(id,kind,name,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)',
            ).run(
              entity.id,
              entity.kind,
              entity.name,
              entity.revision,
              entity.createdAt,
              entity.updatedAt,
            );
          db.prepare(
            'INSERT INTO configuration_revisions(entity_id,revision,name,payload,created_at) VALUES(?,?,?,?,?)',
          ).run(
            entity.id,
            entity.revision,
            entity.name,
            JSON.stringify(entity.payload),
            entity.updatedAt,
          );
        }
        for (const { entity } of pending) {
          db.prepare('DELETE FROM configuration_references WHERE source_id=?').run(entity.id);
          for (const target of new Set(references(entity).map((r) => r.id))) {
            db.prepare('INSERT INTO configuration_references(source_id,target_id) VALUES(?,?)').run(
              entity.id,
              target,
            );
          }
        }
        return pending.map(({ entity }) => store.get(entity.kind, entity.id));
      })();
    },
    archive(kind, id, expectedRevision) {
      db.transaction(() => {
        const entity = store.get(kind, id);
        if (entity.revision !== expectedRevision)
          configurationError('Configuration changed', 'CONFIG_CHANGED', 409);
        if (
          db
            .prepare(`SELECT 1 FROM configuration_references r JOIN configuration_entities e
          ON e.id=r.source_id WHERE r.target_id=? AND e.archived=0 LIMIT 1`)
            .get(id)
        ) {
          configurationError('Configuration is still referenced', 'CONFIG_IN_USE', 409);
        }
        db.prepare('UPDATE configuration_entities SET archived=1 WHERE id=?').run(id);
      })();
    },
    assertCurrent(revisions) {
      for (const r of revisions) {
        const current = store.get(r.kind, r.id);
        if (current.revision !== r.revision)
          configurationError('Configuration changed after preview', 'CONFIG_CHANGED', 409);
      }
    },
  };
  return store;
}
