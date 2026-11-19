import { tmpdir } from 'node:os';
import { z } from 'zod';
import { canonical, sha256 } from '../managed/canonical.js';
import { parseManagedCliConfig } from '../managed/cli-config.js';
import { admitManagedRequest, REQUIRED_ENFORCEMENT } from '../managed/grants.js';
import { parseManagedProfileSetConfig } from '../managed/profile-set-config.js';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import {
  combinedPolicyDigest,
  gatePolicySchema,
  gateStatementBytes,
  type Role,
  verifyGateReceipt,
} from './combined-attestation.js';
import { withVerifiedCheckpointMirror } from './local-checkpoints.js';
import {
  confinedCatalog,
  enrolledOperator,
  operatorBasePolicy,
  operatorDraftSchema,
  operatorSeedInput,
  parseOperatorEnrollment,
} from './operator-enrollment.js';
import { operatorRunId } from './operator-runs.js';

// Offline compatibility with isolated sandbox enrollments on 99cba00e. Never
// open the service DB, use a provider, install config, or accept private keys.
export async function checkInspectionDraft(
  raw: unknown,
  profileRaw: string,
  cliRaw: string,
  bundle: Buffer,
) {
  const draft = operatorDraftSchema.parse(raw);
  const profiles = parseManagedProfileSetConfig(profileRaw),
    cli = parseManagedCliConfig(cliRaw, false);
  if (
    !cli ||
    !profiles ||
    profiles.catalogArtifacts ||
    profiles.source ||
    profiles.githubRead ||
    profiles.mirror.dependencyCachePath ||
    profiles.profiles.length !== 1 ||
    profiles.profiles[0]?.profileSnapshot.route.executionTarget !== 'sandbox'
  )
    throw new Error('inspection-profile-scope');
  if (
    draft.slot !== 'inspection' ||
    draft.budget.requests > 18 ||
    draft.budget.active > 6 ||
    Object.keys(draft.recipes).join(',') !== 'inspect' ||
    canonical(draft.main) !==
      canonical({
        profileName: 'repofit',
        profileId: 'profile-f3ec3b28e6369a8879e2a1da',
        profileRevision: 2,
        aiId: 'ai-2aa5da9e201c0adf52150c71',
        aiRevision: 8,
        accountId: 'anth-pro',
        model: 'claude-sonnet-5-5',
      })
  )
    throw new Error('inspection-run-scope');
  const catalog = confinedCatalog(draft, profiles);
  const req = catalog.inspect;
  if (!req) throw new Error('inspection-recipe-required');
  const snap = profiles.profiles[0].profileSnapshot;
  if (
    canonical(snap.scope) !== canonical(req.effectiveGrant.scope) ||
    snap.route.runtime !== 'codex' ||
    req.outputs.artifacts.limits.maxFiles !== 1 ||
    req.outputs.artifacts.limits.maxTotalBytes > 16384
  )
    throw new Error('inspection-report-scope');
  if (
    !('maxProviderRequests' in snap.budget) ||
    snap.budget.maxProviderRequests > 2 ||
    !('maxProviderRequests' in req.effectiveGrant.budget) ||
    req.effectiveGrant.budget.maxProviderRequests > 2
  )
    throw new Error('inspection-worker-budget');
  admitManagedRequest(
    req,
    {
      targets: ['sandbox'],
      profiles: new Map([[snap.snapshotDigest, snap]]),
      enrollmentCeiling: snap.scope,
      identityCeiling: snap.scope,
      backendCeiling: snap.scope,
      enforcement: REQUIRED_ENFORCEMENT,
    },
    Math.floor(Date.now() / 1000),
  );
  if (
    !bundle.length ||
    bundle.length > MAX_CANDIDATE_BYTES ||
    sha256(bundle) !== draft.source.bundleDigest
  )
    throw new Error('inspection-bundle-mismatch');
  await withVerifiedCheckpointMirror(tmpdir(), draft.source, bundle, async () => {});
  const run = operatorRunId(enrolledOperator(draft, cli, profiles), draft.slot);
  return {
    draft,
    run,
    repository: profiles.mirror.enrollmentId,
    basePolicyDigest: operatorBasePolicy(draft, profiles, true),
  };
}

export function signingPacket(
  checked: Awaited<ReturnType<typeof checkInspectionDraft>>,
  trusted: unknown,
) {
  const { draft, run, repository, basePolicyDigest } = checked;
  // Only these two public-key records come from operator-controlled trust input,
  // never from a draft or submitted receipt.
  const pins = z
    .object({ checks: z.unknown(), independentReview: z.unknown() })
    .strict()
    .parse(trusted);
  const authorities = gatePolicySchema.parse({ ...pins, basePolicyDigest });
  const { commit, tree, predecessor } = draft.source;
  const subject = {
    run,
    repository,
    policyDigest: combinedPolicyDigest(authorities),
    commit,
    tree,
    predecessor,
  };
  return {
    draft,
    authorities,
    subject,
    inputDigest: operatorSeedInput(subject, draft.source.bundleDigest),
  };
}
type Packet = ReturnType<typeof signingPacket>;
export function evaluatorStatement(packet: Packet, role: Role, evidence: Buffer) {
  const decision = z
    .object({
      role: z.literal(role),
      inputDigest: z.literal(packet.inputDigest),
      status: z.literal('passed'),
      findings: z.string().trim().min(1).max(16384),
    })
    .strict()
    .parse(JSON.parse(evidence.toString('utf8')));
  const { identity, configurationDigest } = packet.authorities[role];
  const statement = {
    role,
    identity,
    configurationDigest,
    inputDigest: decision.inputDigest,
    status: decision.status,
    evidenceDigest: sha256(evidence),
  };
  return { statement, bytes: gateStatementBytes(statement) };
}
export function assembleInspection(packet: Packet, checks: unknown, review: unknown) {
  verifyGateReceipt(packet.authorities, 'checks', packet.inputDigest, checks);
  verifyGateReceipt(packet.authorities, 'independentReview', packet.inputDigest, review);
  const envelope = parseOperatorEnrollment(
    JSON.stringify({ ...packet.draft, authorities: packet.authorities, checks, review }),
  );
  if (!envelope) throw new Error('inspection-envelope-required');
  return envelope;
}
