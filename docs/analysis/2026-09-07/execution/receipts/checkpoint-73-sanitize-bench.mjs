import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sanitize } from '/private/tmp/autopod-durable-execution/packages/shared/dist/index.js';
const inputs = [
  ...Array.from({ length: 24 }, (_, i) => `${i}-${'p'.repeat(8000)}`),
  `tail-${'q'.repeat(7945)}`,
  `target blocker ${'x'.repeat(200)}`,
  'a@b.co2c@d.com',
  'user+tag@example.com next@test.invalid',
  'x'.repeat(8000) + '@example.com',
];
const outputs = [];
const times = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const result = inputs.map((text) =>
    sanitize(text, { preset: 'strict', allowedDomains: ['example.com'] }),
  );
  times.push(performance.now() - started);
  outputs.push(createHash('sha256').update(JSON.stringify(result)).digest('hex'));
}
console.log(
  JSON.stringify(
    {
      inputs: inputs.length,
      timesMs: times,
      outputHashes: outputs,
      note: 'Local sanitizer microbenchmark; identical inputs, configuration and output digest. Not validation-reuse or live-workload evidence.',
    },
    null,
    2,
  ),
);
