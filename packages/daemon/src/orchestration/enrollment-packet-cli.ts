import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { MAX_CANDIDATE_BYTES } from '../managed/source-git.js';
import { verifyGateReceipt } from './combined-attestation.js';
import {
  assembleInspection,
  checkInspectionDraft,
  evaluatorStatement,
  signingPacket,
} from './enrollment-packet.js';
import { readEvaluatorPublicPins } from './evaluator-public-pins.js';

// Read fixed names only; bundlePath in a draft refers to the eventual daemon,
// not a path to open on an evaluator machine.
async function read(dir: string, name: string, limit = 256 * 1024) {
  const f = await open(
    path.join(dir, name),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const stat = await f.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit)
      throw new Error('packet-file-size: ' + name);
    const b = Buffer.alloc(stat.size);
    let pos = 0;
    while (pos < b.length) {
      const { bytesRead } = await f.read(b, pos, b.length - pos, pos);
      if (!bytesRead) throw new Error('packet-file-short');
      pos += bytesRead;
    }
    return b;
  } finally {
    await f.close();
  }
}
async function main() {
  const [mode, dir, role, ...extra] = process.argv.slice(2);
  if (
    !dir ||
    extra.length ||
    !(
      mode === 'owner' ||
      mode === 'preflight' ||
      mode === 'packet' ||
      mode === 'statement' ||
      mode === 'receipt' ||
      mode === 'assemble'
    ) ||
    (mode === 'statement' || mode === 'receipt'
      ? role !== 'checks' && role !== 'independentReview'
      : role !== undefined)
  )
    throw new Error(
      'usage: enrollment-packet-cli {owner|preflight|packet|statement|receipt|assemble} DIRECTORY [checks|independentReview]',
    );
  const json = async (name: string) => JSON.parse((await read(dir, name)).toString());
  const checked = await checkInspectionDraft(
    await json('draft.json'),
    String(await read(dir, 'profiles.json')),
    String(await read(dir, 'cli.json')),
    await read(dir, 'inspection.bundle', MAX_CANDIDATE_BYTES),
  );
  if (mode === 'owner' && checked.draft.parent)
    throw new Error('parent-requires-signed-v1-enrollment');
  if (mode === 'owner')
    return {
      ...checked.draft,
      version: 2,
      expectedRun: checked.run,
      expectedBasePolicy: checked.basePolicyDigest,
    };
  if (mode === 'preflight')
    return {
      status: 'unsigned',
      run: checked.run,
      basePolicyDigest: checked.basePolicyDigest,
      bundleDigest: checked.draft.source.bundleDigest,
    };
  const trustFile = process.env.AUTOPOD_EVALUATOR_PUBLIC_POLICY;
  if (!trustFile || !path.isAbsolute(trustFile))
    throw new Error('independently-provisioned-public-policy-required');
  const packet = signingPacket(checked, await readEvaluatorPublicPins(trustFile));
  if (mode === 'packet') return packet;
  if (role === 'checks' || role === 'independentReview') {
    const { statement, bytes } = evaluatorStatement(
      packet,
      role,
      await read(dir, role + '.evidence.json'),
    );
    if (mode === 'statement') {
      process.stdout.write(bytes);
      return;
    }
    const receipt = {
      statement,
      signature: (await read(dir, role + '.signature', 64)).toString('base64url'),
    };
    verifyGateReceipt(packet.authorities, role, packet.inputDigest, receipt);
    return receipt;
  }
  return assembleInspection(
    packet,
    await json('checks.receipt.json'),
    await json('independentReview.receipt.json'),
  );
}
main()
  .then((value) => {
    if (value) console.log(JSON.stringify(value));
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : 'enrollment-packet-error');
    process.exitCode = 1;
  });
