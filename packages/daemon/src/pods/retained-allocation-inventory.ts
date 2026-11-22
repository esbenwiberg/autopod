import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type PhysicalIdentity = {
  path: string;
  realpath: string;
  device: string;
  inode: string;
  birthtimeNs: string;
};

export type GitWorktreeIdentity = {
  worktree: PhysicalIdentity;
  gitlink: PhysicalIdentity;
  registration: PhysicalIdentity;
  commonStore: PhysicalIdentity;
  commonStoreOwnership: 'shared-cache' | 'private-prepared';
};

type PreparedSource = {
  sourceReference: GitWorktreeIdentity;
  privateRoot: PhysicalIdentity;
  privateGit: GitWorktreeIdentity;
  privateSnapshotRoot: PhysicalIdentity;
  privateSnapshot: PhysicalIdentity;
  privateSnapshotReceipt: PhysicalIdentity;
  privateBundle: PhysicalIdentity;
};

export const isDockerNativeId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

export type NativeIdentity = { engineId: string; id: string };

type Evidence = {
  bridge: NativeIdentity;
  container: NativeIdentity & { bridge: NativeIdentity; sourceMount: string | null };
  'original-worktree': GitWorktreeIdentity;
  'prepared-source': PreparedSource;
  unsupported: never;
};
type Role = keyof Evidence;
type PendingOrRefused = {
  state: 'pending' | 'reused-or-foreign' | 'unverified';
  detail?: string;
};

type Allocation<R extends Role = Role> = R extends Role
  ? {
      id: string;
      version: 1;
      taskId: string;
      executionId: string;
      podId: string;
      generation: number;
      role: R;
      locator: string;
      recoveryId: string | null;
      createReply: { engineId: string | null; id: string } | null;
    } & ({ state: 'owned'; evidence: Evidence[R] } | PendingOrRefused)
  : never;

type Incomplete = {
  code:
    | 'missing-task-coverage'
    | 'legacy-execution'
    | 'unsupported-topology'
    | 'unsupported-generation'
    | 'pending-allocation'
    | 'reused-or-foreign'
    | 'unverified-allocation'
    | 'missing-bridge-or-container'
    | 'bridge-binding-mismatch'
    | 'missing-worktree'
    | 'missing-prepared-source'
    | 'source-binding-mismatch';
  podId?: string;
  generation?: number;
  attemptId?: string;
  recoveryId?: string;
};

export interface AllocationScope {
  begin<R extends Role>(
    role: R,
    locator: string,
  ): {
    id: string;
    createReply(evidence: { engineId: string | null; id: string }): void;
    owned(evidence: Evidence[R]): void;
    refuse(state: 'reused-or-foreign' | 'unverified', detail: string): void;
  };
  knowsBridge(evidence: NativeIdentity): boolean;
  matchesWorktree(evidence: GitWorktreeIdentity): boolean;
  recoveryId: string | null;
}

type Membership = { task_id: string; execution_id: string; lifecycle_generation: number };
type Member = Membership & {
  pod_id: string;
  history_archived: number;
  execution_target: string;
  agent_mode: string;
  output_target: string;
  worktree_path: string | null;
  container_id: string | null;
  born: number | null;
};

type Checkpoint = {
  id: string;
  pod_id: string;
  generation: number;
  container_id: string;
  resource_key: string;
  worktree_path: string;
  target_generation: number | null;
  worktree: string | null;
  bare: string | null;
  snapshot: string | null;
  bundle: string | null;
  supported: number;
};

export function createRetainedAllocationInventory(db: Database.Database) {
  function scope(podId: string, recoveryId: string | null = null): AllocationScope | undefined {
    const membership = db
      .prepare(`SELECT task_id,execution_id,lifecycle_generation FROM task_executions
      JOIN pods ON pods.id=task_executions.pod_id WHERE pod_id=?`)
      .get(podId) as Membership | undefined;
    if (!membership) return;
    const {
      task_id: taskId,
      execution_id: executionId,
      lifecycle_generation: generation,
    } = membership;
    return {
      recoveryId,
      begin(role, locator) {
        if (db.inTransaction) throw new Error('Allocation intent must commit before dispatch');
        const id = randomUUID();
        db.prepare(`INSERT INTO retained_allocation_attempts
          (id,version,task_id,execution_id,pod_id,generation,role,locator,recovery_id)
          VALUES (?,1,?,?,?,?,?,?,?)`).run(
          id,
          taskId,
          executionId,
          podId,
          generation,
          role,
          locator,
          recoveryId,
        );
        const fact = (kind: string, evidence: unknown): void => {
          db.prepare('INSERT INTO retained_allocation_facts VALUES (?,?,?)').run(
            id,
            kind,
            JSON.stringify(evidence),
          );
        };
        return {
          id,
          createReply: (evidence) => fact('create-reply', evidence),
          owned: (evidence) => fact('owned', evidence),
          refuse: (state, detail) => fact(state, { detail }),
        };
      },
      matchesWorktree(evidence) {
        const sources = db
          .prepare(`SELECT f.evidence FROM retained_allocation_attempts a
          JOIN retained_allocation_facts f ON f.attempt_id=a.id AND f.kind='owned'
          WHERE a.execution_id=? AND ((a.role='original-worktree' AND a.generation=1 AND ?=1)
             OR (a.role='prepared-source' AND a.recovery_id=? AND a.generation=?-1))`)
          .all(executionId, generation, recoveryId, generation) as { evidence: string }[];
        return sources.some((row) => {
          const identity = JSON.parse(row.evidence);
          return JSON.stringify(identity.privateGit ?? identity) === JSON.stringify(evidence);
        });
      },
      knowsBridge(evidence) {
        return Boolean(
          db
            .prepare(`SELECT 1 FROM retained_allocation_attempts a
          JOIN retained_allocation_facts f ON f.attempt_id=a.id AND f.kind='owned'
          WHERE a.execution_id=? AND a.role='bridge'
          AND json_extract(f.evidence,'$.engineId')=? AND json_extract(f.evidence,'$.id')=?`)
            .get(executionId, evidence.engineId, evidence.id),
        );
      },
    };
  }

  // Read one consistent SQLite snapshot, with no limit or dependence on live names/attachments.
  const readTask = db.transaction((taskId: string) => {
    const rows = db
      .prepare(`SELECT a.*, r.evidence AS reply, o.kind AS state, o.evidence AS outcome
      FROM retained_allocation_attempts a
      LEFT JOIN retained_allocation_facts r ON r.attempt_id=a.id AND r.kind='create-reply'
      LEFT JOIN retained_allocation_facts o ON o.attempt_id=a.id AND o.kind<>'create-reply'
      WHERE a.task_id=? ORDER BY a.sequence`)
      .all(taskId) as Array<{
      id: string;
      task_id: string;
      execution_id: string;
      pod_id: string;
      generation: number;
      role: Role;
      locator: string;
      recovery_id: string | null;
      reply: string | null;
      state: Allocation['state'] | null;
      outcome: string | null;
    }>;
    const allocations = rows.map((a) => ({
      id: a.id,
      version: 1,
      taskId: a.task_id,
      executionId: a.execution_id,
      podId: a.pod_id,
      generation: a.generation,
      role: a.role,
      locator: a.locator,
      recoveryId: a.recovery_id,
      createReply: a.reply ? JSON.parse(a.reply) : null,
      state: a.state ?? 'pending',
      ...(a.state === 'owned'
        ? { evidence: JSON.parse(a.outcome ?? 'null') }
        : a.outcome
          ? JSON.parse(a.outcome)
          : {}),
    })) as Allocation[];
    const reasons: Incomplete[] = [];
    for (const a of allocations) {
      if (a.state === 'owned') continue;
      reasons.push({
        code:
          a.state === 'pending'
            ? 'pending-allocation'
            : a.state === 'unverified'
              ? 'unverified-allocation'
              : a.state,
        podId: a.podId,
        generation: a.generation,
        attemptId: a.id,
      });
    }
    const members = db
      .prepare(`SELECT e.*, p.lifecycle_generation,p.history_archived,
        p.execution_target,p.agent_mode,p.output_target,p.worktree_path,p.container_id,b.generation AS born
      FROM retained_task_executions e JOIN retained_pods p ON p.id=e.pod_id
      LEFT JOIN retained_allocation_births b ON b.execution_id=e.execution_id AND b.task_id=e.task_id
      WHERE e.task_id=?`)
      .all(taskId) as Member[];
    if (
      !members.length ||
      db
        .prepare(`SELECT 1 FROM retained_allocation_births b
      WHERE b.task_id=? AND NOT EXISTS (SELECT 1 FROM retained_task_executions e WHERE e.execution_id=b.execution_id)`)
        .get(taskId)
    )
      reasons.push({ code: 'missing-task-coverage' });
    if (members.length > 1) reasons.push({ code: 'unsupported-topology' });
    const checkpoints = db
      .prepare(`SELECT r.*, json_extract(a.evidence,'$.generation') AS target_generation,
        json_extract(p.evidence,'$.worktree') AS worktree, json_extract(p.evidence,'$.bare') AS bare,
        json_extract(p.evidence,'$.snapshot') AS snapshot, json_extract(p.evidence,'$.bundle') AS bundle,
        (json_type(r.binding,'$.continuation')='object'
          AND json_type(r.binding,'$.approvalRewrite') IS NULL
          AND json_type(r.binding,'$.continuation.infrastructure') IS NULL
          AND json_type(r.original_evidence,'$.prevalidationSource') IS NULL) AS supported
      FROM retained_checkpoint_recoveries r
      LEFT JOIN retained_checkpoint_recovery_events a ON a.recovery_id=r.id AND a.kind='activated'
      LEFT JOIN retained_checkpoint_recovery_events p ON p.recovery_id=r.id AND p.kind='prepared'
      WHERE r.task_id=?`)
      .all(taskId) as Checkpoint[];
    if (checkpoints.some((r) => !members.some((m) => m.pod_id === r.pod_id)))
      reasons.push({ code: 'missing-task-coverage' });
    for (const m of members) {
      const podId = m.pod_id;
      const flag = (code: Incomplete['code'], generation?: number, recoveryId?: string) => {
        reasons.push({ code, podId, generation, recoveryId });
      };
      if (m.born !== 1) flag('legacy-execution');
      if (
        m.history_archived ||
        m.execution_target !== 'local' ||
        m.agent_mode !== 'auto' ||
        !['pr', 'branch'].includes(m.output_target) ||
        db
          .prepare(`SELECT 1 FROM approval_source_rewrites WHERE pod_id=?
          UNION ALL SELECT 1 FROM source_adoptions WHERE pod_id=?
          UNION ALL SELECT 1 FROM recovery_forks WHERE parent_pod_id=?
          UNION ALL SELECT 1 FROM artifact_checks_recoveries WHERE pod_id=?`)
          .get(podId, podId, podId, podId)
      )
        flag('unsupported-topology');

      const owned = allocations.filter(
        (a): a is Extract<Allocation, { state: 'owned' }> =>
          a.executionId === m.execution_id && a.state === 'owned',
      );
      const bridges = owned.filter((a) => a.role === 'bridge');
      const containers = owned.filter((a) => a.role === 'container');
      const originalWorktrees = owned.filter((a) => a.role === 'original-worktree');
      const preparedSources = owned.filter((a) => a.role === 'prepared-source');
      for (const c of containers) {
        if (
          !bridges.some(
            (b) =>
              b.generation === c.generation &&
              b.recoveryId === c.recoveryId &&
              b.evidence.id === c.evidence.bridge.id &&
              b.evidence.engineId === c.evidence.bridge.engineId &&
              c.evidence.engineId === b.evidence.engineId,
          )
        )
          flag('bridge-binding-mismatch', c.generation);
      }

      const lineage = checkpoints.filter((r) => r.pod_id === podId);
      const activated = new Map(
        lineage.filter((r) => r.target_generation !== null).map((r) => [r.target_generation, r]),
      );
      if (
        activated.size + 1 !== m.lifecycle_generation ||
        lineage.some(
          (r) =>
            r.target_generation !== null &&
            (r.target_generation !== r.generation + 1 ||
              r.target_generation > m.lifecycle_generation),
        )
      )
        flag('unsupported-generation');
      const original = originalWorktrees.find((s) => s.generation === 1);
      if (!original) flag('missing-worktree', 1);
      for (const r of lineage) {
        const source = preparedSources.find(
          (s) => s.generation === r.generation && s.recoveryId === r.id,
        );
        if (!r.supported) flag('unsupported-topology', r.generation, r.id);
        if (
          !source ||
          source.evidence.privateGit.worktree.path !== r.worktree ||
          source.evidence.privateGit.commonStore.path !== r.bare ||
          source.evidence.privateSnapshot.path !== r.snapshot ||
          source.evidence.privateBundle.path !== r.bundle
        )
          flag('missing-prepared-source', r.generation, r.id);
        const previous = activated.get(r.generation);
        const input = previous
          ? preparedSources.find((s) => s.recoveryId === previous.id)?.evidence.privateGit
          : original?.evidence;
        if (
          !input ||
          input.worktree.path !== r.worktree_path ||
          (source && JSON.stringify(source.evidence.sourceReference) !== JSON.stringify(input))
        )
          flag('source-binding-mismatch', r.generation, r.id);
        if (
          !containers.some(
            (c) =>
              c.generation === r.generation &&
              c.evidence.id === r.container_id &&
              JSON.stringify(['docker', c.evidence.engineId, c.evidence.id]) === r.resource_key,
          )
        )
          flag('missing-bridge-or-container', r.generation, r.id);
      }
      for (const generation of [1, ...activated.keys()]) {
        if (generation === null) continue;
        const allocated = containers.filter((c) => c.generation === generation);
        const expectedRecoveryId = activated.get(generation)?.id ?? null;
        if (allocated.some((c) => c.recoveryId !== expectedRecoveryId))
          flag('unsupported-generation', generation);
        if (!allocated.length) flag('missing-bridge-or-container', generation);
        const expectedPath =
          generation === 1 ? original?.evidence.worktree.path : activated.get(generation)?.worktree;
        if (!expectedPath || allocated.some((c) => c.evidence.sourceMount !== expectedPath))
          flag('source-binding-mismatch', generation);
        if (
          generation === m.lifecycle_generation &&
          (m.worktree_path !== expectedPath ||
            !allocated.some((c) => c.evidence.id === m.container_id))
        )
          flag('source-binding-mismatch', generation);
      }
    }
    return {
      version: 1 as const,
      taskId,
      state: reasons.length ? ('incomplete' as const) : ('recorded' as const),
      allocations,
      reasons,
    };
  });
  return { scope, readTask: (taskId: string) => readTask(taskId) };
}
