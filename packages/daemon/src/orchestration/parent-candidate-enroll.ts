import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { canonical } from '../managed/canonical.js';
import {
  assembleInspection,
  checkInspectionDraft,
  evaluatorStatement,
  signingPacket,
} from './enrollment-packet.js';
import { assertParentCandidateSeed, parentCandidateChecksDigest } from './parent-candidate-host.js';
import { openParentCandidateKeys } from './parent-candidate-keys.js';

async function readInput(root: string, name: string, limit: number) {
  const fd = await open(
    path.join(root, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size < 1 ||
      stat.size > limit
    )
      throw new Error('parent-candidate-enrollment-input-refused');
    const bytes = Buffer.alloc(stat.size + 1);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await fd.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    if (position !== stat.size) throw new Error('parent-candidate-enrollment-input-refused');
    return bytes.subarray(0, position);
  } finally {
    await fd.close();
  }
}

/** Explicit offline owner acceptance of the frozen seed, not qualification of a result. */
export async function enrollParentCandidate(
  root: string,
  reviewDigest: string,
  expectedInput?: string,
) {
  // This checks the private, canonical root before reading any enrollment inputs.
  const keys = await openParentCandidateKeys(root, parentCandidateChecksDigest, reviewDigest);
  const [draftRaw, profiles, cli, bundle] = await Promise.all([
    readInput(root, 'draft.json', 256 * 1024),
    readInput(root, 'profiles.json', 256 * 1024),
    readInput(root, 'cli.json', 16384),
    readInput(root, 'seed.bundle', 4096),
  ]);
  const checked = await checkInspectionDraft(
    JSON.parse(draftRaw.toString('utf8')),
    profiles.toString('utf8'),
    cli.toString('utf8'),
    bundle,
  );
  const { draft } = checked;
  const coding = draft.parent?.coding;
  if (
    draft.version !== 1 ||
    !coding?.sandbox?.hostQualification ||
    !coding.sandbox.singleOwnerReceipts ||
    coding.sandbox.authorizeEvaluatorDispatch ||
    coding.evaluation ||
    draft.source.bundlePath !== path.join(root, 'seed.bundle')
  )
    throw new Error('parent-candidate-enrollment-mode-refused');
  assertParentCandidateSeed(draft);
  const packet = signingPacket(checked, keys.pins);
  if (expectedInput === undefined) return packet; // preview only; no signature
  if (expectedInput !== packet.inputDigest) throw new Error('parent-candidate-enrollment-drift');
  // The seed input uses autopod.operator-seed.v1, not the integration gate domain.
  const seedReceipt = (role: 'checks' | 'independentReview') => {
    const evidence = Buffer.from(
      canonical({
        role,
        inputDigest: packet.inputDigest,
        status: 'passed',
        findings:
          'Owner-approved fictional seed and confinement verified offline. Not a child result, test pass, or model review.',
      }),
    );
    return keys.bind(
      packet.authorities,
      role,
    )(evaluatorStatement(packet, role, evidence).statement);
  };
  return assembleInspection(
    packet,
    await seedReceipt('checks'),
    await seedReceipt('independentReview'),
  );
}
