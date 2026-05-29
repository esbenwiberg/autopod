import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import {
  AutopodError,
  type SpecContract,
  type SpecFile,
  generateId,
  numericPrefix,
  parseBriefs,
} from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import type { PodManager } from '../../pods/index.js';
import { selectGitPat } from '../../profiles/profile-pat.js';
import type { ProfileStore } from '../../profiles/profile-store.js';
import { serializePodForWire } from '../wire-serializers.js';

interface ParsedBrief {
  title: string;
  task: string;
  dependsOn: string[];
  contract?: SpecContract;
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
  /** Optional branch/ref to start root pod branches from. PRs still target baseBranch. */
  startBranch?: string;
  baseBranch?: string;
  /** Local spec files to commit onto root pod branches before agents start. */
  specFiles?: SpecFile[];
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

interface PreviewBriefFolderRequest {
  folderPath: string;
}

interface PreviewBriefOnBranchRequest {
  profileName: string;
  branch: string;
  /** Relative path in the repo, e.g. `specs/my-feature/briefs/01-ui`. */
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

function specFileOutputRoot(specRoot: string): string {
  const name = basename(resolve(specRoot)) || 'spec';
  return `specs/${name}`;
}

const pathSeparatorRegex = /[/\\]+/g;

function readSpecFiles(specRoot: string): SpecFile[] {
  const root = resolve(specRoot);
  const outputRoot = specFileOutputRoot(root);
  const files: SpecFile[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const rel = full
        .slice(root.length + 1)
        .split(pathSeparatorRegex)
        .join('/');
      files.push({
        path: `${outputRoot}/${rel}`,
        content: readFileSync(full, 'utf-8'),
      });
    }
  }

  walk(root);
  return files;
}

function readBriefFiles(briefsDir: string): Array<{
  filename: string;
  content: string;
  contractContent?: string;
}> {
  const entries = readdirSync(briefsDir);
  const briefDirs = entries
    .filter((entry) => {
      const full = join(briefsDir, entry);
      return statSync(full).isDirectory() && existsSync(join(full, 'brief.md'));
    })
    .sort((a, b) => numericPrefix(a) - numericPrefix(b));
  if (briefDirs.length > 0) {
    return briefDirs.map((dirname) => ({
      filename: dirname,
      content: readFileSync(join(briefsDir, dirname, 'brief.md'), 'utf-8'),
      contractContent: readFileSync(join(briefsDir, dirname, 'contract.yaml'), 'utf-8'),
    }));
  }
  return entries
    .filter((f) => extname(f) === '.md')
    .sort((a, b) => numericPrefix(a) - numericPrefix(b))
    .map((filename) => ({
      filename,
      content: readFileSync(join(briefsDir, filename), 'utf-8'),
    }));
}

function readSingleBriefFiles(specRoot: string): Array<{
  filename: string;
  content: string;
  contractContent?: string;
}> {
  const briefPath = join(specRoot, 'brief.md');
  const contractPath = join(specRoot, 'contract.yaml');
  const hasDirectBrief = existsSync(briefPath);
  const hasDirectContract = existsSync(contractPath);
  if (hasDirectBrief || hasDirectContract) {
    if (!hasDirectBrief) {
      throw new AutopodError(`brief.md not found in ${specRoot}`, 'BRIEF_NOT_FOUND', 404);
    }
    if (!hasDirectContract) {
      throw new AutopodError(`contract.yaml not found in ${specRoot}`, 'CONTRACT_NOT_FOUND', 404);
    }
    return [
      {
        filename: basename(specRoot),
        content: readFileSync(briefPath, 'utf-8'),
        contractContent: readFileSync(contractPath, 'utf-8'),
      },
    ];
  }

  const { briefsDir } = resolveSpecLayout(specRoot);
  try {
    return readBriefFiles(briefsDir);
  } catch {
    throw new AutopodError(`Cannot read brief folder: ${briefsDir}`, 'BRIEF_READ_FAILED', 400);
  }
}

function parseSingleBrief(
  briefFiles: Array<{ filename: string; content: string; contractContent?: string }>,
  options: {
    sourceDescription: string;
    loadContextFile?: (path: string) => string;
  },
): ParsedBrief {
  if (briefFiles.length === 0) {
    throw new AutopodError(
      `No contract brief found at ${options.sourceDescription}`,
      'BRIEF_NOT_FOUND',
      400,
    );
  }
  if (briefFiles.length > 1) {
    throw new AutopodError(
      `Expected exactly one contract brief at ${options.sourceDescription}, found ${briefFiles.length}`,
      'MULTIPLE_BRIEFS_FOUND',
      400,
    );
  }

  const [brief] = parseBriefs(briefFiles, options.loadContextFile);
  if (!brief) {
    throw new AutopodError(
      `No contract brief found at ${options.sourceDescription}`,
      'BRIEF_NOT_FOUND',
      400,
    );
  }
  if (!brief.contract) {
    throw new AutopodError(
      `contract.yaml is required for ${options.sourceDescription}`,
      'CONTRACT_NOT_FOUND',
      400,
    );
  }
  return brief;
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
            startBranch: isRoot ? body.startBranch : undefined,
            baseBranch: isRoot ? (body.baseBranch ?? undefined) : undefined,
            specFiles: isRoot && body.specFiles?.length ? body.specFiles : undefined,
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
            contract: brief.contract,
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

    const createdPods = created.map(({ title, pod }) => ({
      title,
      ...(serializePodForWire(pod) as Record<string, unknown>),
    }));
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

    let briefFiles: Array<{ filename: string; content: string; contractContent?: string }>;
    try {
      briefFiles = readBriefFiles(briefsDir);
    } catch {
      reply.status(400);
      return { error: `Cannot read briefs folder: ${briefsDir}` };
    }
    if (briefFiles.length === 0) {
      reply.status(400);
      return { error: `No contract brief folders found in ${briefsDir}` };
    }

    const seriesDescription = readSpecDoc(specRoot, 'purpose.md');
    const seriesDesign = readSpecDoc(specRoot, 'design.md');
    const specFiles = readSpecFiles(specRoot);

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
      specFiles,
      seriesDescription: seriesDescription || undefined,
      seriesDesign: seriesDesign || undefined,
    };
  });

  // POST /pods/brief/preview — parse a single `/prep` spec folder on the
  // daemon host. The folder itself must contain brief.md + contract.yaml.
  app.post('/pods/brief/preview', async (request, reply) => {
    const body = request.body as PreviewBriefFolderRequest;
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

    const contextRoot = existsSync(join(folderPath, 'brief.md'))
      ? folderPath
      : resolveSpecLayout(folderPath).specRoot;
    const loadContextFile = (p: string): string => {
      if (isAbsolute(p) || p.includes('..')) return '';
      try {
        return readFileSync(resolve(contextRoot, p), 'utf-8').trim();
      } catch {
        return '';
      }
    };

    try {
      const brief = parseSingleBrief(readSingleBriefFiles(folderPath), {
        sourceDescription: folderPath,
        loadContextFile,
      });
      return { ...brief, specFiles: readSpecFiles(folderPath) };
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      throw err;
    }
  });

  // POST /pods/brief/preview-branch — parse a single `/prep` folder directly
  // from a git branch, without creating a checkout.
  app.post('/pods/brief/preview-branch', async (request, reply) => {
    const body = request.body as PreviewBriefOnBranchRequest;
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
      return parseSingleBrief(contents.files, {
        sourceDescription: `${body.path} on ${body.branch}`,
      });
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message, code: err.code };
      }
      reply.status(400);
      return {
        error: err instanceof Error ? err.message : 'Failed to read branch brief folder',
      };
    }
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
