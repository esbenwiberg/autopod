import { chmod, cp, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ContainerManager } from '../interfaces/container-manager.js';
import { collectArtifactSnapshot } from './artifact-preservation.js';
import {
  fingerprintArtifactSnapshot,
  verifyArtifactSnapshot,
} from './artifact-snapshot-receipt.js';
import { sourceAdoptionError } from './source-adoption-repository.js';

function disjointTrees(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
    );
  };
  return !contains(left, right) && !contains(right, left);
}

/** Copies all workspace bytes, not just tracked paths. External symlink targets are NOT archived. */
export async function preserveSourceWorkspaces(options: {
  containerManager: ContainerManager;
  containerId: string;
  worktreePath: string;
  archiveRoot: string;
  generation: number;
  assertCurrent(): void;
}) {
  const source = path.resolve(options.worktreePath);
  const root = path.resolve(options.archiveRoot);
  if (!disjointTrees(source, root))
    sourceAdoptionError('Archive must be outside the source workspace');
  const sourceStat = await lstat(source);
  const physicalSource = await realpath(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    sourceAdoptionError('Source must be a real workspace directory');
  // Resolve the nearest existing ancestor before mkdir: an indirect archive
  // symlink must not even create a directory inside the original workspace.
  let ancestor = root;
  const missing: string[] = [];
  let planned: string;
  for (;;) {
    try {
      planned = path.join(await realpath(ancestor), ...missing);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const outside = (directory: string) => disjointTrees(physicalSource, directory);
  if (!outside(planned)) sourceAdoptionError('Archive must be physically outside the source');
  options.assertCurrent();
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  // Claim a fresh private namespace. Never chmod/reuse someone else's directory
  // or repeat an uncertain earlier capture after a disconnect/restart.
  await mkdir(root, { mode: 0o700 });
  if (!outside(await realpath(root)))
    sourceAdoptionError('Archive namespace changed during preparation');
  await chmod(root, 0o700);
  const current = () => {
    try {
      options.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const host = await collectArtifactSnapshot({
    containerId: options.containerId,
    artifactRoot: path.join(root, 'host'),
    generation: options.generation,
    isCurrent: current,
    containerManager: {
      async extractDirectoryFromContainer(_id, _source, destination) {
        options.assertCurrent();
        const before = await fingerprintArtifactSnapshot(source);
        await cp(source, destination, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
        await chmod(destination, (await lstat(source)).mode & 0o777);
        options.assertCurrent();
        const after = await fingerprintArtifactSnapshot(source);
        const copied = await fingerprintArtifactSnapshot(destination);
        if (before.sha256 !== after.sha256 || before.sha256 !== copied.sha256)
          sourceAdoptionError('Host workspace changed while capturing source and ignored files');
      },
    },
  });
  options.assertCurrent();
  const container = await collectArtifactSnapshot({
    containerManager: options.containerManager,
    containerId: options.containerId,
    artifactRoot: path.join(root, 'container'),
    generation: options.generation,
    isCurrent: current,
    // Always use the guarded export path: sandbox auth/resume awaits must not
    // outlive source ownership. This does not authorize an unjournaled wakeup.
    wakeupTimeoutMs: 120_000,
  });
  options.assertCurrent();
  await verifyArtifactSnapshot(host, path.join(root, 'host'), options.generation, 0);
  await verifyArtifactSnapshot(container, path.join(root, 'container'), options.generation, 0);
  options.assertCurrent();
  return { host, container };
}
