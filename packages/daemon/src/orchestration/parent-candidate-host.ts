import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { EffectiveLaunchConfig } from '@autopod/shared';
import { z } from 'zod';
import { configurationError } from '../configuration/configuration-store.js';
import { canonical, digest } from '../managed/canonical.js';
import { managedGitBytes } from '../managed/source-git.js';
import type { CombinedPolicy } from './combined-attestation.js';
import { readEvaluatorPublicPins } from './evaluator-public-pins.js';
import type { parseOperatorEnrollment } from './operator-enrollment.js';
import { openParentCandidateKeys } from './parent-candidate-keys.js';
import type { ParentEvaluatorPorts } from './parent-exact-tree-evaluator.js';
import type { ParentHostGatePorts } from './parent-host-gates.js';
import { assertReceiptSocket, createParentReceiptSigner } from './parent-receipt-socket.js';

const seed = {
  commit: '4433513abda28d894c6eb50bc190e83f586561fc',
  predecessor: '998790caea571172ce170760e96e88f3572271aa',
  tree: '54aed6ddcb59115462aad31d1d477708f6273da5',
  bundleDigest: 'sha256:17dc0ff1494c0ed511e235134dc5061a435eb51e0d6b25bcddd0174b2cd53c78',
} as const;
export const parentCandidateSeed = seed;

/** Conservative snapshot only. The local parent and isolated reviewer use
 * different bridges. Do not count reclaimable or retained bridges as free. */
export async function requireParentCandidateNetworkHeadroom(
  readFree: () => Promise<number | null>,
) {
  const free = await readFree().catch(() => null);
  if (free === null || !Number.isSafeInteger(free) || free < 0)
    configurationError(
      'Could not verify Docker subnet capacity for the parent and its independent reviewer. No trial started.',
      'PARENT_NETWORK_CAPACITY_UNKNOWN',
      503,
    );
  if (free < 2)
    configurationError(
      `This trial needs two free Docker subnets (parent and independent reviewer); Docker reports ${free}. Free capacity before launch.`,
      'PARENT_NETWORK_CAPACITY',
      409,
    );
}
const expectedTree = '3e8bd73a2ff40626744eca4b704a88afefd00482';
const expected = [
  ['sample/count.txt', '24\n'],
  ['sample/reason.txt', '24 is twice 12\n'],
] as const;
export const parentCandidateChecksDigest = digest([
  'autopod.fictional-count-checks/v1',
  seed,
  expected,
]);
export function parentCandidateReviewDigest(
  reviewer: EffectiveLaunchConfig['ai']['reviewer'],
  image: string,
) {
  return digest(['autopod.parent-private-review/v1', reviewer, image]);
}

export const evaluateParentCandidate: ParentEvaluatorPorts['evaluate'] = async ({
  mirror,
  commit,
  tree,
  predecessor,
}) => {
  if (predecessor !== seed.commit) throw new Error('parent-candidate-source-refused');
  const git = (args: string[], input = '') =>
    managedGitBytes(mirror, args, undefined, [], { input, maxBuffer: 8192, timeout: 5000 });
  const prior = await git(['show', predecessor + ':sample/count.txt']);
  const changes = await git([
    'diff-tree',
    '--no-commit-id',
    '--no-renames',
    '-r',
    '--name-status',
    '-z',
    predecessor,
    commit,
  ]);
  const entries = await git(['ls-tree', '-r', '-z', commit]);
  const expectedEntries: string[] = [];
  for (const [filename, contents] of expected) {
    const hash = (await git(['hash-object', '--stdin'], contents)).toString('utf8').trim();
    expectedEntries.push(`100644 blob ${hash}\t${filename}\0`);
  }
  const passed =
    tree === expectedTree &&
    prior.equals(Buffer.from('12\n')) &&
    Number(prior) * 2 === Number(expected[0][1]) &&
    changes.equals(Buffer.from('M\0sample/count.txt\0A\0sample/reason.txt\0')) &&
    entries.equals(Buffer.from(expectedEntries.join('')));
  return {
    status: passed ? 'passed' : 'failed',
    evidence: Buffer.from(canonical({ commit, tree, predecessor, passed })),
  };
};

export function assertParentCandidateSeed(applied: {
  source: Record<keyof typeof seed, string>;
  parent?: { coding?: { paths: string[]; sandbox?: { secondPaths: string[] } } };
  budget: { active: number; workers: number };
}) {
  const coding = applied.parent?.coding;
  if (
    Object.entries(seed).some(
      ([key, value]) => applied.source[key as keyof typeof seed] !== value,
    ) ||
    canonical(coding?.paths ?? []) !== canonical([expected[0][0]]) ||
    canonical(coding?.sandbox?.secondPaths ?? []) !== canonical([expected[1][0]]) ||
    applied.budget.active !== 2 ||
    applied.budget.workers !== 2
  )
    throw new Error('parent-candidate-source-refused');
}

const endpointSchema = z
  .object({ socket: z.string().min(1).max(100), uid: z.number().int().positive() })
  .strict();
const socketsSchema = z
  .object({ checks: endpointSchema, independentReview: endpointSchema })
  .strict();
async function existing(filename: string) {
  return lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

// Start from a clean environment. Candidate execution must not inherit fleet,
// publishing, telemetry, arbitrary output locations or provider-secret env knobs.
const candidateEnv = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
  // macOS can inject this locale marker even into a clean posix_spawn env.
  ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
  'PORT',
  'HOST',
  'NODE_ENV',
  'LOG_LEVEL',
  'DB_PATH',
  'DATA_DIR',
  'AUTOPOD_WORKTREE_DIR',
  'AUTOPOD_PARENT_CANDIDATE_DIR',
  'AUTOPOD_PARENT_RECEIPT_SOCKETS',
  'AUTOPOD_OPERATOR_ENROLLMENT',
  'AUTOPOD_OPERATOR_PROFILE_SET',
  'AUTOPOD_OPERATOR_SANDBOX_TARGET',
  'AUTOPOD_MANAGED_CLI',
  'AUTOPOD_EVALUATOR_PUBLIC_POLICY',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_AUDIENCE',
  'AUTOPOD_CONTAINER_HOST',
  'AUTOPOD_MCP_BASE_URL',
  'AZURE_CONFIG_DIR',
  'AZURE_TOKEN_CREDENTIALS',
]);

/** Read-only gate, before database open or any infrastructure/credential handling. */
export async function prepareParentCandidate(
  selected: boolean,
  env: NodeJS.ProcessEnv,
  enrollment: ReturnType<typeof parseOperatorEnrollment>,
) {
  const sandbox = enrollment?.parent?.coding?.sandbox;
  if (!selected) {
    if (sandbox?.hostQualification) throw new Error('parent-candidate-entrypoint-required');
    return undefined;
  }
  const root = env.AUTOPOD_PARENT_CANDIDATE_DIR;
  const uid = process.getuid?.();
  if (
    !root ||
    !uid ||
    !path.isAbsolute(root) ||
    env.HOST !== '127.0.0.1' ||
    env.HOME !== path.join(root, 'home') ||
    env.DB_PATH !== path.join(root, 'autopod.db') ||
    env.DATA_DIR !== path.join(root, 'data') ||
    env.AUTOPOD_WORKTREE_DIR !== path.join(root, 'worktrees') ||
    Object.keys(env).some((name) => !candidateEnv.has(name)) ||
    !env.AUTOPOD_OPERATOR_PROFILE_SET ||
    !env.AUTOPOD_OPERATOR_SANDBOX_TARGET ||
    !enrollment ||
    enrollment.version !== 1 ||
    !enrollment.parent?.coding ||
    !sandbox?.hostQualification ||
    sandbox.authorizeEvaluatorDispatch ||
    enrollment.parent.coding.evaluation
  )
    throw new Error('parent-candidate-boundary-required');
  for (const dir of [root, env.HOME]) {
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.uid !== uid ||
      stat.mode & 0o077 ||
      dir !== (await realpath(dir))
    )
      throw new Error('parent-candidate-directory-refused');
  }
  // The dedicated root may be reopened after a crash, but never along a link
  // into the ordinary daemon tree (including SQLite sidecars and managed storage).
  for (const filename of ['autopod.db', 'autopod.db-wal', 'autopod.db-shm', 'autopod.db-journal']) {
    const file = await existing(path.join(root, filename));
    if (file && (!file.isFile() || file.uid !== uid || file.nlink !== 1))
      throw new Error('parent-candidate-database-refused');
  }
  for (const key of ['data', 'worktrees', 'managed', 'home/.autopod']) {
    const dir = path.join(root, key);
    const stat = await existing(dir);
    if (
      stat &&
      (!stat.isDirectory() ||
        stat.uid !== uid ||
        stat.mode & 0o022 ||
        dir !== (await realpath(dir)))
    )
      throw new Error('parent-candidate-directory-refused');
  }
  // macOS candidate HOME is isolated. Reuse only an explicitly selected CLI
  // login, never copy credentials into the candidate or fall back to another identity.
  const cliDirectory = env.AZURE_CONFIG_DIR;
  if (cliDirectory !== undefined || env.AZURE_TOKEN_CREDENTIALS !== undefined) {
    if (
      !sandbox.singleOwnerReceipts ||
      env.AZURE_TOKEN_CREDENTIALS !== 'AzureCliCredential' ||
      !cliDirectory ||
      !path.isAbsolute(cliDirectory) ||
      cliDirectory !== (await realpath(cliDirectory))
    )
      throw new Error('parent-candidate-azure-cli-refused');
    const cliStat = await lstat(cliDirectory);
    if (!cliStat.isDirectory() || cliStat.uid !== uid || cliStat.mode & 0o022)
      throw new Error('parent-candidate-azure-cli-refused');
  }
  assertParentCandidateSeed(enrollment);
  if (enrollment.authorities.checks.configurationDigest !== parentCandidateChecksDigest)
    throw new Error('parent-candidate-source-refused');

  const policy: CombinedPolicy = enrollment.authorities;
  const local = sandbox.singleOwnerReceipts === true;
  if (
    local &&
    (env.AUTOPOD_PARENT_RECEIPT_SOCKETS !== undefined ||
      env.AUTOPOD_EVALUATOR_PUBLIC_POLICY !== undefined)
  )
    throw new Error('parent-candidate-receipt-mode-conflict');
  const keys = local
    ? await openParentCandidateKeys(
        root,
        parentCandidateChecksDigest,
        policy.independentReview.configurationDigest,
      )
    : undefined;
  const pins = keys?.pins ?? (await readEvaluatorPublicPins(env.AUTOPOD_EVALUATOR_PUBLIC_POLICY));
  if (
    canonical(pins.checks) !== canonical(enrollment.authorities.checks) ||
    canonical(pins.independentReview) !== canonical(enrollment.authorities.independentReview)
  )
    throw new Error(
      local
        ? 'parent-candidate-key-pin-mismatch'
        : 'independently-provisioned-public-policy-required',
    );
  const socketSigners = async () => {
    const raw = env.AUTOPOD_PARENT_RECEIPT_SOCKETS;
    const sockets = (() => {
      try {
        if (!raw || Buffer.byteLength(raw) > 1024) throw new Error();
        return socketsSchema.parse(JSON.parse(raw));
      } catch {
        throw new Error('parent-receipt-sockets-required');
      }
    })();
    if (
      sockets.checks.uid === sockets.independentReview.uid ||
      sockets.checks.socket === sockets.independentReview.socket
    )
      throw new Error('parent-receipt-separation-required');
    const validate = (endpoint: typeof sockets.checks) => assertReceiptSocket(endpoint, uid);
    await Promise.all([validate(sockets.checks), validate(sockets.independentReview)]);
    return {
      checks: createParentReceiptSigner(policy, 'checks', sockets.checks, validate),
      review: createParentReceiptSigner(
        policy,
        'independentReview',
        sockets.independentReview,
        validate,
      ),
    };
  };
  const signers = keys
    ? { checks: keys.bind(policy, 'checks'), review: keys.bind(policy, 'independentReview') }
    : await socketSigners();

  return {
    pins,
    requireNetworkHeadroom: requireParentCandidateNetworkHeadroom,
    receiptTrust: local ? ('single-owner-local' as const) : ('separate-unix-authorities' as const),
    requireLaunch(request: {
      requestId?: string;
      expectedDigest?: string;
      requireParentEnrollment?: boolean;
    }) {
      if (
        request.requestId !== enrollment.parent!.requestId ||
        request.expectedDigest !== enrollment.parent!.launchDigest ||
        !request.requireParentEnrollment
      )
        configurationError(
          'Only the enrolled candidate Task is allowed',
          'PARENT_ENROLLMENT_REQUIRED',
          409,
        );
    },
    bind(image: string | undefined, review: Omit<ParentHostGatePorts['review'], 'sign'>) {
      if (!image) throw new Error('parent-candidate-review-image-required');
      const assertLaunch = (config: EffectiveLaunchConfig) => {
        const { reviewer } = config.ai;
        if (
          config.digest !== enrollment.parent!.launchDigest ||
          config.intent !== 'task' ||
          config.execution.target !== 'local' ||
          config.work.inputBundle ||
          config.repository ||
          config.worker ||
          config.requiredSidecarIds.length ||
          reviewer.mode !== 'independent' ||
          reviewer.route.maxHops !== 0 ||
          reviewer.route.failover.length ||
          reviewer.route.providerAccountId === config.ai.main.providerAccountId ||
          config.ai.main.failover.length ||
          parentCandidateReviewDigest(reviewer, image) !==
            policy.independentReview.configurationDigest
        )
          configurationError(
            'Candidate launch or review route differs from enrollment',
            'PARENT_LAUNCH_REFUSED',
            409,
          );
      };
      const ports: ParentHostGatePorts = {
        receiptTrust: local ? 'single-owner-local' : undefined,
        checks: { evaluate: evaluateParentCandidate, sign: signers.checks },
        review: {
          ...review,
          readLaunch(id) {
            const config = review.readLaunch(id);
            if (config) assertLaunch(config);
            return config;
          },
          sign: signers.review,
        },
      };
      return { assertLaunch, ports };
    },
  };
}
