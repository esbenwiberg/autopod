import type { ScheduledJobTemplate } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface ScheduledJobTemplateRepository {
  insert(template: Omit<ScheduledJobTemplate, 'createdAt' | 'updatedAt'>): ScheduledJobTemplate;
  getOrThrow(id: string): ScheduledJobTemplate;
  list(): ScheduledJobTemplate[];
  update(
    id: string,
    changes: Partial<Pick<ScheduledJobTemplate, 'name' | 'prompt'>>,
  ): ScheduledJobTemplate;
  delete(id: string): void;
  countLinkedJobs(id: string): number;
}

function mapRow(row: Record<string, unknown>): ScheduledJobTemplate {
  return {
    id: row.id as string,
    name: row.name as string,
    prompt: Buffer.isBuffer(row.prompt)
      ? (row.prompt as Buffer).toString('utf8')
      : (row.prompt as string),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function ensureUniqueName(db: Database.Database, name: string, exceptId?: string): void {
  const row = db
    .prepare(`
      SELECT id FROM scheduled_job_templates
      WHERE lower(name) = lower(?)
        AND (? IS NULL OR id != ?)
      LIMIT 1
    `)
    .get(name, exceptId ?? null, exceptId ?? null) as { id: string } | undefined;

  if (row) {
    throw new AutopodError(`Scheduled job template already exists: ${name}`, 'CONFLICT', 409);
  }
}

export function createScheduledJobTemplateRepository(
  db: Database.Database,
): ScheduledJobTemplateRepository {
  return {
    insert(template: Omit<ScheduledJobTemplate, 'createdAt' | 'updatedAt'>): ScheduledJobTemplate {
      ensureUniqueName(db, template.name);

      db.prepare(`
        INSERT INTO scheduled_job_templates (id, name, prompt)
        VALUES (@id, @name, @prompt)
      `).run({
        id: template.id,
        name: template.name,
        prompt: template.prompt,
      });

      return this.getOrThrow(template.id);
    },

    getOrThrow(id: string): ScheduledJobTemplate {
      const row = db.prepare('SELECT * FROM scheduled_job_templates WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!row) {
        throw new AutopodError(`Scheduled job template not found: ${id}`, 'NOT_FOUND', 404);
      }
      return mapRow(row);
    },

    list(): ScheduledJobTemplate[] {
      const rows = db
        .prepare('SELECT * FROM scheduled_job_templates ORDER BY name ASC')
        .all() as Record<string, unknown>[];
      return rows.map(mapRow);
    },

    update(
      id: string,
      changes: Partial<Pick<ScheduledJobTemplate, 'name' | 'prompt'>>,
    ): ScheduledJobTemplate {
      this.getOrThrow(id);

      const setClauses: string[] = ["updated_at = datetime('now')"];
      const params: Record<string, unknown> = { id };

      if (changes.name !== undefined) {
        ensureUniqueName(db, changes.name, id);
        setClauses.push('name = @name');
        params.name = changes.name;
      }
      if (changes.prompt !== undefined) {
        setClauses.push('prompt = @prompt');
        params.prompt = changes.prompt;
      }

      db.prepare(`UPDATE scheduled_job_templates SET ${setClauses.join(', ')} WHERE id = @id`).run(
        params,
      );
      return this.getOrThrow(id);
    },

    delete(id: string): void {
      this.getOrThrow(id);
      const linked = this.countLinkedJobs(id);
      if (linked > 0) {
        throw new AutopodError(
          `Scheduled job template "${id}" is used by ${linked} scheduled job${
            linked === 1 ? '' : 's'
          }`,
          'CONFLICT',
          409,
        );
      }
      db.prepare('DELETE FROM scheduled_job_templates WHERE id = ?').run(id);
    },

    countLinkedJobs(id: string): number {
      const row = db
        .prepare('SELECT COUNT(*) as count FROM scheduled_jobs WHERE template_id = ?')
        .get(id) as { count: number };
      return row.count;
    },
  };
}
