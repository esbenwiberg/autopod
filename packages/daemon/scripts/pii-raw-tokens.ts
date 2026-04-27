import pino from 'pino';
import { createModelManager } from '../src/security/index.js';

const mm = createModelManager({ logger: pino({ level: 'warn' }) });

const SAMPLES = [
  'Please contact John Smith for details.',
  'The product owner is Esben Wiberg.',
  'Met with Jane Doe at Acme Corporation yesterday.',
  'Reach Sarah Chen at sarah.chen@example.com.',
];

async function main() {
  const c = await mm.getPiiClassifier();
  if (!c) {
    console.error('classifier not loaded');
    process.exit(1);
  }
  for (const s of SAMPLES) {
    console.log(`\n── "${s}"`);
    const tokens = await c(s);
    for (const t of tokens) {
      const flag =
        t.entity && !['O', 'LABEL_0'].includes(t.entity.replace(/^[BI]-/, '')) ? '★' : ' ';
      console.log(`  ${flag} ${t.entity?.padEnd(18)} score=${t.score.toFixed(3)} word="${t.word}"`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
