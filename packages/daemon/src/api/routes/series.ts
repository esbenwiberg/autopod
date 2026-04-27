import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import {
  type AcDefinition,
  AutopodError,
  generateId,
  numericPrefix,
  parseBriefs,
} from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import type { PodManager } from '../../pods/index.js';
import { selectGitPat } from '../../profiles/profile-pat.js';
import type { ProfileStore } from '../../profiles/profile-store.js';

interface ParsedBrief {
  title: string;
  task: string;
  dependsOn: string[];
  acceptanceCriteria?: AcDefinition[];
  /** Per-brief advisory list of files this pod expects to modify. */
  touches?: string[];
  /** Per-brief advisory list of files this pod should not modify. */
  doesNotTouch?: string[];
  /**
   * Per-brief sidecar requests (e.g. `['dagger']`). Validated by the pod
   * manager at createSession against `profile.sidecars` and `trustedSource`.
   */
  requireSidecars?: string[];
}

interface CreateSeriesRequest {
  seriesName: string;
  briefs: ParsedBrief[];
  profile: string;
  baseBranch?: string;
  prMode?: 'single' | 'stacked' | 'none';
  /** Auto-approve each pod once it reaches validated — no human gate needed. */
  autoApprove?: boolean;
  /** Redirect agent ask_human calls to the reviewer AI model instead of blocking. */
  disableAskHuman?: boolean;
  /** Series purpose (from `purpose.md`). Used as the PR "Why" + `## Purpose` in CLAUDE.md. */
  seriesDescription?: string;
  /** Series design (from `design.md`). Rendered as `## Design` in CLAUDE.md. */
  seriesDesign?: string;
}

interface PreviewSeriesFolderRequest {
  folderPath: string;
}

interface PreviewSeriesOnBranchRequest {
  profileName: string;
  branch: string;
  /** Relative path in the repo, e.g. `specs/my-feature` or `specs/my-feature/briefs`. */
  path: string;
}

/**
 * Resolve the spec layout for a folder argument. Accepts either the spec root
 * (`specs/<feature>/` containing `briefs/`) or the briefs folder itself
 * (`specs/<feature>/briefs/`).
 */
function resolveSpecLayout(folderPath: string): { specRoot: string; briefsDir: string } {
  const abs = resolve(folderPath);
  const folderName = basename(abs);
  if (folderName === 'briefs') {
    return { specRoot: resolve(abs, '..'), briefsDir: abs };
  }
  const briefsSubdir = join(abs, 'briefs');
  if (existsSync(briefsSubdir) && statSync(briefsSubdir).isDirectory()) {
    return { specRoot: abs, briefsDir: briefsSubdir };
  }
  return { specRoot: abs, briefsDir: abs };
}

function readSpecDoc(specRoot: string, name: string): string {
  try {
    return readFileSync(join(specRoot, name), 'utf-8').trim();
  } catch {
    return '';
  }
}

export function seriesRoutes(
  app: FastifyInstance,
  podManager: PodManager,
  profileStore: ProfileStore,
  worktreeManager: WorktreeManager,
): void {
  // POST /pods/series — create a series of pods from parsed briefs
  app.post('/pods/series', async (request, reply) => {
    const body = request.body as CreateSeriesRequest;

    if (!body.seriesName || !body.briefs || body.briefs.length === 0 || !body.profile) {
      reply.status(400);
      return { error: 'seriesName, briefs, and profile are required' };
    }

    const rawSlug = body.seriesName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const seriesId = rawSlug || generateId(12);
    const prMode = body.prMode ?? 'single';
    const userId = request.user.oid;

    // Resolve brief title → pod ID in creation order (topological).
    // Briefs must be ordered such that each brief's dependsOn references only
    // earlier briefs (numeric-prefix ordering from ap series create guarantees this).
    const titleToId = new Map<string, string>();
    const created: Array<{ title: string; pod: ReturnType<(typeof podManager)['createSession']> }> =
      [];

    // In single mode all pods share the root pod's branch so every commit lands
    // on one branch and the final pod opens a single PR.
    let singleModeBranch: string | undefined;

    for (let i = 0; i < body.briefs.length; i++) {
      const brief = body.briefs[i];
      if (!brief) continue;
      const isLast = i === body.briefs.length - 1;

      // Resolve all parent titles to pod IDs — enables fan-in (a pod can wait
      // on multiple parents). Unresolved titles are dropped rather than throwing
      // so partial briefs don't break the whole series.
      const briefDependsOnPodIds: string[] = brief.dependsOn
        .map((t) => titleToId.get(t))
        .filter((id): id is string => typeof id === 'string');

      const isRoot = briefDependsOnPodIds.length === 0;

      // Single mode: every pod shares the root's branch, and Git allows only one
      // worktree per branch. Chain each pod to the previous one in creation order
      // so siblings serialize on the shared branch — the DAG then matches physical
      // scheduling instead of pretending fan-out is possible.
      const previousSiblingId =
        prMode === 'single' && i > 0 ? created[created.length - 1]?.pod.id : undefined;

      const dependsOnPodIds: string[] = previousSiblingId
        ? Array.from(new Set([...briefDependsOnPodIds, previousSiblingId]))
        : briefDependsOnPodIds;

      const output: 'branch' | 'pr' =
        prMode === 'stacked' ? 'pr' : prMode === 'single' && isLast ? 'pr' : 'branch';

      try {
        const pod = podManager.createSession(
          {
            profileName: body.profile,
            task: brief.task,
            briefTitle: brief.title,
            baseBranch: isRoot ? (body.baseBranch ?? undefined) : undefined,
            dependsOnPodIds: dependsOnPodIds.length > 0 ? dependsOnPodIds : undefined,
            // Single mode: non-root pods reuse the root's branch so all commits
            // land on one branch and the final pod creates a single PR.
            branch: prMode === 'single' && !isRoot ? singleModeBranch : undefined,
            seriesId,
            seriesName: body.seriesName,
            seriesDescription: body.seriesDescription ?? null,
            seriesDesign: body.seriesDesign ?? null,
            touches: brief.touches,
            doesNotTouch: brief.doesNotTouch,
            prMode,
            acceptanceCriteria: brief.acceptanceCriteria,
            options: { agentMode: 'auto', output },
            // Per-brief sidecars (e.g. Dagger engine for a pipeline-wiring pod).
            // Validated against the profile's sidecar config + trustedSource
            // inside createSession — an untrusted profile aborts the series
            // fast with a 403 rather than at pod-spawn time.
            requireSidecars: brief.requireSidecars,
            // Stacked non-root pods wait for their parent PR to fully merge before
            // starting so they always build on top of merged (green) code.
            waitForMerge: prMode === 'stacked' && !isRoot,
            autoApprove: body.autoApprove ?? false,
            disableAskHuman: body.disableAskHuman ?? false,
          },
          userId,
        );

        if (isRoot && prMode === 'single') {
          singleModeBranch = pod.branch;
        }

        titleToId.set(brief.title, pod.id);
        created.push({ title: brief.title, pod });
      } catch (err) {
        if (err instanceof AutopodError) {
          reply.status(err.statusCode ?? 400);
          return { error: err.message };
        }
        throw err;
      }
    }

    const createdPods = created.map(({ title, pod }) => ({ title, ...pod }));
    const statusCounts = createdPods.reduce(
      (acc, p) => {
        acc[p.status] = (acc[p.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    reply.status(201);
    return {
      seriesId,
      seriesName: body.seriesName,
      pods: createdPods,
      tokenUsageSummary: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      statusCounts,
    };
  });

  // POST /pods/series/preview — parse a spec folder on the daemon host and
  // return the DAG for the desktop's "Create Series" sheet. Read-only.
  app.post('/pods/series/preview', async (request, reply) => {
    const body = request.body as PreviewSeriesFolderRequest;
    if (!body?.folderPath || typeof body.folderPath !== 'string') {
      reply.status(400);
      return { error: 'folderPath is required' };
    }
    if (!isAbsolute(body.folderPath)) {
      reply.status(400);
      return { error: 'folderPath must be an absolute path' };
    }

    const folderPath = resolve(body.folderPath);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(folderPath);
    } catch {
      reply.status(404);
      return { error: `Folder not found: ${folderPath}` };
    }
    if (!stat.isDirectory()) {
      reply.status(400);
      return { error: `Not a directory: ${folderPath}` };
    }

    const { specRoot, briefsDir } = resolveSpecLayout(folderPath);

    let filenames: string[];
    try {
      filenames = readdirSync(briefsDir)
        .filter((f) => extname(f) === '.md')
        .sort((a, b) => numericPrefix(a) - numericPrefix(b));
    } catch {
      reply.status(400);
      return { error: `Cannot read briefs folder: ${briefsDir}` };
    }
    if (filenames.length === 0) {
      reply.status(400);
      return { error: `No .md brief files found in ${briefsDir}` };
    }

    const briefFiles = filenames.map((filename) => ({
      filename,
      content: readFileSync(join(briefsDir, filename), 'utf-8'),
    }));

    const seriesDescription = readSpecDoc(specRoot, 'purpose.md');
    const seriesDesign = readSpecDoc(specRoot, 'design.md');

    // Resolve per-brief context_files relative to the spec root, restricted to
    // paths that don't escape it. Prevents arbitrary file reads outside the
    // spec.
    const loadContextFile = (p: string): string => {
      if (isAbsolute(p) || p.includes('..')) return '';
      try {
        return readFileSync(resolve(specRoot, p), 'utf-8').trim();
      } catch {
        return '';
      }
    };

    const briefs = parseBriefs(briefFiles, loadContextFile);
    const seriesName = inferSeriesNameFromRoot(specRoot);

    return {
      seriesName,
      briefs,
      seriesDescription: seriesDescription || undefined,
      seriesDesign: seriesDesign || undefined,
    };
  });

  // POST /pods/series/preview-branch — parse a spec folder directly from a
  // git branch (no local checkout). Use when the spec lives on the branch
  // (e.g. an interactive pod's worktree).
  app.post('/pods/series/preview-branch', async (request, reply) => {
    const body = request.body as PreviewSeriesOnBranchRequest;
    if (!body?.profileName || !body?.branch || !body?.path) {
      reply.status(400);
      return { error: 'profileName, branch, and path are required' };
    }

    let profile: ReturnType<ProfileStore['get']>;
    try {
      profile = profileStore.get(body.profileName);
    } catch {
      reply.status(404);
      return { error: `Profile not found: ${body.profileName}` };
    }

    if (!profile.repoUrl) {
      reply.status(400);
      return { error: 'Profile has no repoUrl — cannot read branch contents' };
    }

    try {
      const contents = await worktreeManager.readBranchFolder({
        repoUrl: profile.repoUrl,
        branch: body.branch,
        relPath: body.path,
        pat: selectGitPat(profile),
      });

      if (contents.files.length === 0) {
        reply.status(400);
        return {
          error: `No .md brief files found at ${body.path} on branch ${body.branch}`,
        };
      }

      const briefs = parseBriefs(contents.files);
      const parts = body.path.split('/').filter(Boolean);
      const lastPart = parts[parts.length - 1] ?? body.branch;
      const parentPart = parts[parts.length - 2];
      const seriesName = lastPart === 'briefs' && parentPart ? parentPart : lastPart;

      return {
        seriesName,
        briefs,
        seriesDescription: contents.purposeMd || undefined,
        seriesDesign: contents.designMd || undefined,
      };
    } catch (err) {
      reply.status(400);
      return {
        error: err instanceof Error ? err.message : 'Failed to read branch folder',
      };
    }
  });

  // DELETE /pods/series/:seriesId — kill all running pods, then delete all pods in the series
  app.delete('/pods/series/:seriesId', async (request, reply) => {
    const { seriesId } = request.params as { seriesId: string };
    await podManager.deleteSeriesWithCascade(seriesId);
    reply.status(204);
  });

  // GET /pods/series/:seriesId — all pods in a series with cost roll-up
  app.get('/pods/series/:seriesId', async (request, reply) => {
    const { seriesId } = request.params as { seriesId: string };
    const pods = podManager.getSeriesPods(seriesId);

    if (pods.length === 0) {
      reply.status(404);
      return { error: 'Series not found' };
    }

    const tokenUsageSummary = {
      inputTokens: pods.reduce((sum, p) => sum + p.inputTokens, 0),
      outputTokens: pods.reduce((sum, p) => sum + p.outputTokens, 0),
      costUsd: Number(pods.reduce((sum, p) => sum + p.costUsd, 0).toFixed(4)),
    };

    const statusCounts = pods.reduce(
      (acc, p) => {
        acc[p.status] = (acc[p.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      seriesId,
      seriesName: pods[0]?.seriesName ?? seriesId,
      pods,
      tokenUsageSummary,
      statusCounts,
    };
  });
}

function inferSeriesNameFromRoot(specRoot: string): string {
  return basename(resolve(specRoot));
}
