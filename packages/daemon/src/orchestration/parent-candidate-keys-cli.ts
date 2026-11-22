import { enrollParentCandidate } from './parent-candidate-enroll.js';
import { parentCandidateChecksDigest } from './parent-candidate-host.js';
import { initializeParentCandidateKeys, openParentCandidateKeys } from './parent-candidate-keys.js';

try {
  const [verb, root, reviewDigest, expectedInput, ...extra] = process.argv.slice(2);
  const hash = /^sha256:[a-f0-9]{64}$/;
  if (
    extra.length ||
    (verb !== 'init' && verb !== 'pins' && verb !== 'preview' && verb !== 'enroll') ||
    (verb === 'enroll'
      ? !expectedInput || !hash.test(expectedInput)
      : expectedInput !== undefined) ||
    !root ||
    !reviewDigest ||
    !hash.test(reviewDigest)
  )
    throw new Error('invalid arguments');
  if (verb === 'init') await initializeParentCandidateKeys(root);
  const result =
    verb === 'enroll' || verb === 'preview'
      ? await enrollParentCandidate(root, reviewDigest, expectedInput)
      : (await openParentCandidateKeys(root, parentCandidateChecksDigest, reviewDigest)).pins;
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch {
  // No arguments, key bytes, file contents or parser errors in stderr.
  process.stderr.write('parent-candidate-keys-refused\n');
  process.exitCode = 1;
}
