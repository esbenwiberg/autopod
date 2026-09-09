import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { ContainerSpawnConfig } from '../interfaces/container-manager.js';
import { managedGit } from './source-git.js';

export interface ManagedRepositoryMirror {
  enrollmentId: string;
  path: string;
  remote: string;
  baseRevision: string;
  /** Reviewed read-only dependency tree baked into the immutable worker image. */
  dependencyCachePath?: string;
}

/** Independent Git copies: no shared .git file, hardlinks, credentials, or user-checkout writes. */
export class ManagedWorkspaces {
  constructor(
    readonly db: Database.Database,
    readonly root: string,
    readonly mirrors: readonly ManagedRepositoryMirror[],
  ) {}
  async prepare(
    podId: string,
    request: ManagedPodRequest,
  ): Promise<NonNullable<ContainerSpawnConfig['volumes']>> {
    if (!/^managed-[A-Za-z0-9-]+$/.test(podId)) throw new Error('managed-workspace-pod-invalid');
    const directory = path.join(this.root, podId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const volumes: NonNullable<ContainerSpawnConfig['volumes']> = [];
    for (const repository of request.effectiveGrant.scope.repositories) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(repository.enrollmentId))
        throw new Error('managed-workspace-enrollment-invalid');
      const matches = this.mirrors.filter((item) => item.enrollmentId === repository.enrollmentId);
      const mirror = matches[0];
      if (
        matches.length !== 1 ||
        !mirror ||
        !path.isAbsolute(mirror.path) ||
        mirror.remote !== repository.remote ||
        mirror.baseRevision !== repository.baseRevision
      )
        throw new Error('managed-workspace-enrollment-mismatch');
      if (
        mirror.dependencyCachePath &&
        !/^\/opt\/autopod-managed\/[A-Za-z0-9_.-]+\/node_modules$/.test(mirror.dependencyCachePath)
      )
        throw new Error('managed-workspace-dependency-cache-invalid');
      const destination = path.join(directory, repository.enrollmentId);
      const prior = this.db
        .prepare('SELECT * FROM managed_workspaces WHERE pod_id=? AND repository_id=?')
        .get(podId, repository.enrollmentId) as
        | { spec_digest: string; base_commit: string; local_path: string; state: string }
        | undefined;
      if (
        prior &&
        (prior.spec_digest !== request.executionSpecDigest ||
          prior.base_commit !== repository.baseRevision ||
          prior.local_path !== destination)
      )
        throw new Error('managed-workspace-immutable-conflict');
      this.db
        .prepare(
          'INSERT OR IGNORE INTO managed_workspaces(pod_id,repository_id,spec_digest,base_commit,local_path) VALUES (?,?,?,?,?)',
        )
        .run(
          podId,
          repository.enrollmentId,
          request.executionSpecDigest,
          repository.baseRevision,
          destination,
        );
      if (prior?.state !== 'ready') {
        let exists = true;
        try {
          await lstat(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          exists = false;
        }
        if (!exists) {
          const staging = `${destination}.${randomUUID()}.staging`;
          try {
            await managedGit(
              directory,
              ['clone', '--no-local', '--no-hardlinks', '--no-checkout', mirror.path, staging],
              undefined,
              [mirror.path],
            );
            await managedGit(staging, ['remote', 'remove', 'origin']);
            await managedGit(staging, ['checkout', '--detach', repository.baseRevision]);
            await rename(staging, destination);
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        }
        if (
          (await lstat(destination)).isSymbolicLink() ||
          (await lstat(path.join(destination, '.git'))).isSymbolicLink() ||
          (await managedGit(destination, ['rev-parse', 'HEAD'])) !== repository.baseRevision
        )
          throw new Error('managed-workspace-unverified');
        if (mirror.dependencyCachePath) {
          const link = path.join(destination, 'node_modules');
          try {
            await symlink(mirror.dependencyCachePath, link, 'dir');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (
              !(await lstat(link)).isSymbolicLink() ||
              (await readlink(link)) !== mirror.dependencyCachePath
            )
              throw new Error('managed-workspace-dependency-cache-conflict');
          }
          if ((await managedGit(destination, ['check-ignore', 'node_modules'])) !== 'node_modules')
            throw new Error('managed-workspace-dependency-cache-not-ignored');
        }
        this.db
          .prepare("UPDATE managed_workspaces SET state='ready' WHERE pod_id=? AND repository_id=?")
          .run(podId, repository.enrollmentId);
      }
      if (mirror.dependencyCachePath) {
        const link = path.join(destination, 'node_modules');
        if (
          !(await lstat(link)).isSymbolicLink() ||
          (await readlink(link)) !== mirror.dependencyCachePath
        )
          throw new Error('managed-workspace-dependency-cache-unverified');
        if ((await managedGit(destination, ['check-ignore', 'node_modules'])) !== 'node_modules')
          throw new Error('managed-workspace-dependency-cache-not-ignored');
      }
      volumes.push({
        host: destination,
        container: `/repositories/${repository.enrollmentId}`,
        readOnly: repository.access === 'read',
      });
    }
    if (request.outputs.artifacts.mode !== 'none') {
      const output = path.join(directory, 'output');
      await mkdir(output, { recursive: true, mode: 0o700 });
      volumes.push({ host: output, container: '/output', readOnly: false });
    }
    return volumes;
  }
  path(podId: string, repositoryId: string): string {
    const row = this.db
      .prepare(
        "SELECT local_path FROM managed_workspaces WHERE pod_id=? AND repository_id=? AND state='ready'",
      )
      .get(podId, repositoryId) as { local_path: string } | undefined;
    if (!row) throw new Error('managed-workspace-not-ready');
    return row.local_path;
  }
}
