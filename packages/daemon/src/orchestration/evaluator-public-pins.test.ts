import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { digest } from '../managed/canonical.js';
import { fixtureSigner } from '../test-utils/gate-signer.js';
import { readEvaluatorPublicPins } from './evaluator-public-pins.js';

const refused = 'independently-provisioned-public-policy-required';

it('reads only a bounded, absolute and protected public pin file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'evaluator-pins-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'pins.json');
  const link = path.join(root, 'link.json');
  const pins = {
    checks: fixtureSigner('checks', 'checks', digest('checks/v1')).authority,
    independentReview: fixtureSigner('independentReview', 'review', digest('review/v1')).authority,
  };
  await writeFile(file, JSON.stringify(pins), { mode: 0o600 });
  await symlink(file, link);
  await expect(readEvaluatorPublicPins(file)).resolves.toEqual(pins);
  for (const bad of [undefined, 'pins.json', link, root]) {
    await expect(readEvaluatorPublicPins(bad)).rejects.toThrow(refused);
  }
  await chmod(file, 0o662);
  await expect(readEvaluatorPublicPins(file)).rejects.toThrow(refused);
  await chmod(file, 0o600);
  await writeFile(file, JSON.stringify({ ...pins, extra: true }));
  await expect(readEvaluatorPublicPins(file)).rejects.toThrow(refused);
  await writeFile(file, ' '.repeat(8193));
  await expect(readEvaluatorPublicPins(file)).rejects.toThrow(refused);
});
