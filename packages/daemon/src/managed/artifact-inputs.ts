import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactInput, ManagedPodRequest } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { ArtifactStore } from './artifact-store.js';
import { digest, sha256 } from './canonical.js';
import type { ManagedPodRow } from './managed-service.js';

/** Exact input bindings live outside the worker and are never silently replaced. */
export class ManagedArtifactInputs {
  constructor(
    readonly db: Database.Database,
    readonly store: ArtifactStore,
    readonly root: string,
  ) {}
  async check(installation: string, request: ManagedPodRequest): Promise<void> {
    const names = new Set<string>();
    for (const input of request.inputArtifacts) {
      if (
        names.has(input.name) ||
        input.mountPath !== `/inputs/${input.name}` ||
        input.access !== 'read'
      )
        throw new Error('artifact-input-binding-invalid');
      names.add(input.name);
      const owned = this.db
        .prepare(`SELECT artifact_id FROM artifact_exports JOIN managed_pods USING(pod_id)
        WHERE artifact_id=? AND dispatcher_installation_id=? AND artifact_exports.status='committed'`)
        .get(input.backendArtifactId, installation);
      if (!owned) throw new Error('artifact-input-unavailable');
      const manifest = await this.store.getManifest(input.backendArtifactId);
      if (
        manifest.artifactId !== input.backendArtifactId ||
        digest(manifest) !== input.manifestSha256
      )
        throw new Error('artifact-input-digest-mismatch');
    }
  }
  async prepare(row: ManagedPodRow, request: ManagedPodRequest): Promise<void> {
    await this.check(row.dispatcher_installation_id, request);
    const directory = path.join(this.root, row.pod_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const input of request.inputArtifacts) {
      const destination = path.join(directory, input.name);
      this.db
        .transaction(() => {
          const prior = this.db
            .prepare('SELECT * FROM managed_inputs WHERE pod_id=? AND input_name=?')
            .get(row.pod_id, input.name) as Record<string, string> | undefined;
          if (
            prior &&
            (prior.artifact_id !== input.backendArtifactId ||
              prior.manifest_digest !== input.manifestSha256 ||
              prior.mount_path !== input.mountPath ||
              prior.local_path !== destination)
          )
            throw new Error('artifact-input-immutable-conflict');
          this.db
            .prepare(
              'INSERT OR IGNORE INTO managed_inputs(pod_id,input_name,artifact_id,manifest_digest,mount_path,local_path) VALUES (?,?,?,?,?,?)',
            )
            .run(
              row.pod_id,
              input.name,
              input.backendArtifactId,
              input.manifestSha256,
              input.mountPath,
              destination,
            );
        })
        .immediate();
      try {
        await lstat(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.store.materializeInput(input, destination);
      }
      await this.verifyMaterialized(input, destination);
      this.db
        .prepare("UPDATE managed_inputs SET status='ready' WHERE pod_id=? AND input_name=?")
        .run(row.pod_id, input.name);
    }
  }
  private async verifyMaterialized(input: ArtifactInput, destination: string): Promise<void> {
    const manifest = await this.store.getManifest(input.backendArtifactId);
    if (digest(manifest) !== input.manifestSha256)
      throw new Error('artifact-input-digest-mismatch');
    const expected = new Map(manifest.files.map((file) => [file.path, file]));
    const walk = async (directory: string): Promise<void> => {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o222)
        throw new Error('artifact-input-tree-mutated');
      for (const name of await readdir(directory)) {
        const file = path.join(directory, name);
        const entry = await lstat(file);
        if (entry.isSymbolicLink()) throw new Error('artifact-input-tree-mutated');
        if (entry.isDirectory()) {
          await walk(file);
          continue;
        }
        const relative = path.relative(destination, file).split(path.sep).join('/');
        const record = expected.get(relative);
        if (
          !entry.isFile() ||
          entry.nlink !== 1 ||
          entry.mode & 0o222 ||
          !record ||
          record.size !== entry.size ||
          sha256(await readFile(file)) !== record.sha256
        )
          throw new Error('artifact-input-tree-mutated');
        expected.delete(relative);
      }
    };
    await walk(destination);
    if (expected.size) throw new Error('artifact-input-tree-mutated');
  }
  mounts(podId: string): { hostPath: string; containerPath: string; readOnly: true }[] {
    return (
      this.db
        .prepare(
          "SELECT local_path,mount_path FROM managed_inputs WHERE pod_id=? AND status='ready' ORDER BY input_name",
        )
        .all(podId) as { local_path: string; mount_path: string }[]
    ).map((row) => ({ hostPath: row.local_path, containerPath: row.mount_path, readOnly: true }));
  }
}
