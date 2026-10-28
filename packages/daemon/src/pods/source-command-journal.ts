import type { NativeGoalProcessIdentity } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { sourceAdoptionError, sourceHash } from './source-adoption-identity.js';

interface CommandEvent {
  observation: string;
  step: string;
  commandHash?: string;
  backend?: NativeGoalProcessIdentity['backend'];
  containerId?: string;
  identity?: NativeGoalProcessIdentity;
  exitCode?: number;
  error?: string;
  output?: { stdout: string; stderr: string; truncated: boolean };
}
export interface SourceCommandState {
  commandHash: string;
  backend: NativeGoalProcessIdentity['backend'];
  containerId: string;
  identity: NativeGoalProcessIdentity | null;
  exitCode: number | null;
  revoked: boolean;
}
export interface SourceCommandJournal {
  get(adoptionId: string, step: string): SourceCommandState | null;
  claim(
    adoptionId: string,
    step: string,
    command: string[],
    backend: NativeGoalProcessIdentity['backend'],
    assertCurrent: () => void,
  ): void;
  admit(
    adoptionId: string,
    step: string,
    identity: NativeGoalProcessIdentity,
    assertCurrent: () => void,
  ): void;
  started(adoptionId: string, step: string, identity: NativeGoalProcessIdentity): void;
  exited(
    adoptionId: string,
    step: string,
    code: number,
    output?: { stdout: string; stderr: string; truncated: boolean },
  ): void;
  revokeUnsent(adoptionId: string, step: string): void;
  error(adoptionId: string, step: string, code: string): void;
  assertSettled(adoptionId: string): void;
}
/** Process receipts are adapter observations, never model text or inferred from sandbox Stopped. */
export function createSourceCommandJournal(db: Database.Database): SourceCommandJournal {
  const events = (id: string, step?: string): CommandEvent[] =>
    (
      db
        .prepare(`SELECT event FROM source_adoption_events
    WHERE adoption_id=? AND json_extract(event,'$.observation') LIKE 'source-command-%'
    AND (? IS NULL OR json_extract(event,'$.step')=?) ORDER BY sequence`)
        .all(id, step ?? null, step ?? null) as { event: string }[]
    ).map((row) => JSON.parse(row.event) as CommandEvent);
  const append = (id: string, event: CommandEvent) =>
    db
      .prepare('INSERT INTO source_adoption_events(adoption_id,event,created_at) VALUES(?,?,?)')
      .run(id, JSON.stringify(event), new Date().toISOString());
  const get = (id: string, step: string): SourceCommandState | null => {
    const rows = events(id, step);
    const claim = rows.find((row) => row.observation === 'source-command-claimed');
    if (!claim?.commandHash || !claim.backend || !claim.containerId) return null;
    return {
      commandHash: claim.commandHash,
      backend: claim.backend,
      containerId: claim.containerId,
      identity: rows.find((row) => row.observation === 'source-command-admitted')?.identity ?? null,
      exitCode: rows.find((row) => row.observation === 'source-command-exited')?.exitCode ?? null,
      revoked: rows.some((row) => row.observation === 'source-command-unsent-revoked'),
    };
  };
  const assertSettled = (id: string) => {
    for (const row of events(id).filter((row) => row.observation === 'source-command-claimed')) {
      const state = get(id, row.step);
      if (state && !state.revoked && state.exitCode === null)
        sourceAdoptionError(
          'Original source command has no verified exit; observe/terminate the exact recorded exec, never replay.',
          'SOURCE_COMMAND_EXIT_UNVERIFIED',
        );
    }
  };
  const original = (id: string, step: string) =>
    get(id, step) ?? sourceAdoptionError('Original source command admission unavailable');
  return {
    get,
    assertSettled,
    claim: db.transaction<SourceCommandJournal['claim']>(
      (id, step, command, backend, assertCurrent) => {
        assertCurrent();
        if (!/^[a-zA-Z0-9_-]{1,160}$/.test(step) || command.length === 0)
          sourceAdoptionError('Invalid source command step');
        if (get(id, step))
          sourceAdoptionError(
            'Source command already claimed. Observe its receipt, do not repeat.',
            'SOURCE_COMMAND_ALREADY_CLAIMED',
          );
        assertSettled(id);
        const row = db
          .prepare(
            "SELECT binding FROM source_adoptions WHERE id=? AND stage!='checked' AND error IS NULL",
          )
          .get(id) as { binding: string } | undefined;
        if (!row) sourceAdoptionError('Source operation is not current');
        const binding = JSON.parse(row.binding) as { containerId: string };
        append(id, {
          observation: 'source-command-claimed',
          step,
          commandHash: sourceHash(command),
          backend,
          containerId: binding.containerId,
        });
      },
    ),
    admit: db.transaction<SourceCommandJournal['admit']>((id, step, identity, assertCurrent) => {
      assertCurrent();
      const state = original(id, step);
      if (
        state.revoked ||
        state.identity ||
        state.exitCode !== null ||
        identity.backend !== state.backend ||
        identity.containerId !== state.containerId ||
        !identity.execId ||
        !identity.pidPath
      )
        sourceAdoptionError('Source exec identity is unbound, revoked or already admitted');
      append(id, { observation: 'source-command-admitted', step, identity });
    }),
    started(id, step, identity) {
      const state = original(id, step);
      if (!state.identity || sourceHash(state.identity) !== sourceHash(identity))
        sourceAdoptionError('Source start belongs to a different exec');
      append(id, { observation: 'source-command-started', step });
    },
    exited(id, step, exitCode, output) {
      const state = original(id, step);
      if (state.exitCode === exitCode) return;
      if (
        !state.identity ||
        state.revoked ||
        state.exitCode !== null ||
        !Number.isSafeInteger(exitCode)
      )
        sourceAdoptionError('No observed original source exec exit can be recorded');
      append(id, { observation: 'source-command-exited', step, exitCode, output });
    },
    revokeUnsent: db.transaction<SourceCommandJournal['revokeUnsent']>((id, step) => {
      const state = get(id, step);
      if (state && !state.identity && !state.revoked)
        append(id, { observation: 'source-command-unsent-revoked', step });
    }),
    error(id, step, error) {
      original(id, step);
      append(id, { observation: 'source-command-error', step, error: error.slice(0, 500) });
    },
  };
}
