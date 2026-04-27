import pino from 'pino';
import { createModelManager, createPiiDetector } from '../src/security/index.js';

const logger = pino({ level: 'warn' });

const cases: Array<{ label: string; text: string }> = [
  {
    label: 'two-token Western name, plain context',
    text: 'Please contact John Smith for details.',
  },
  { label: 'two-token Western name, no period', text: 'John Smith works on the platform team' },
  { label: 'first-name only', text: 'Ask John about the deploy.' },
  { label: 'three-token name with middle', text: 'The lead engineer is Mary Anne Wong.' },
  { label: 'Nordic name', text: 'The product owner is Esben Wiberg.' },
  { label: 'Asian name (Pinyin)', text: 'Reviewed by Li Wei on April 22.' },
  { label: 'with title', text: 'Dr. Sarah Chen approved the design.' },
  { label: 'all-caps', text: 'Signed off by JOHN SMITH on the PR.' },
  { label: 'name adjacent to email', text: 'Reach John Smith at john.smith@acme.example.' },
  { label: 'name in CSV-style row', text: 'Alice Johnson,Engineer,2026-01-15' },
  { label: 'name in code comment', text: '// TODO(esben): refactor this' },
  { label: 'name in markdown bullet', text: '- Owner: Sarah Chen' },
  { label: 'fictional/famous', text: 'The Mark Zuckerberg of cardiology.' },
  { label: 'name with company', text: 'Met with Jane Doe at Acme Corporation yesterday.' },
];

async function main() {
  const mm = createModelManager({ logger });
  const pii = createPiiDetector({ modelManager: mm });
  await pii.warmup();

  console.log('PII name-detection probe');
  console.log(`model path = ${process.env.AUTOPOD_PII_MODEL_PATH ?? 'HF default'}\n`);

  let nameHits = 0;
  let nameMisses = 0;

  for (const c of cases) {
    const findings = await pii.scan({ path: 'p.txt', content: c.text });
    const nameFindings = findings.filter((f) =>
      /NAME|GIVENNAME|SURNAME|PERSON/i.test(f.ruleId ?? ''),
    );
    const otherFindings = findings.filter(
      (f) => !/NAME|GIVENNAME|SURNAME|PERSON/i.test(f.ruleId ?? ''),
    );
    const hit = nameFindings.length > 0;
    if (hit) nameHits++;
    else nameMisses++;
    const tag = hit ? '✓ NAME' : '✗ ----';
    console.log(`${tag}  [${c.label}]`);
    console.log(`        text: "${c.text}"`);
    if (nameFindings.length) {
      for (const f of nameFindings) {
        console.log(`        → ${f.ruleId} conf=${(f.confidence ?? 0).toFixed(2)}  "${f.snippet}"`);
      }
    }
    if (otherFindings.length) {
      for (const f of otherFindings) {
        console.log(
          `        · also: ${f.ruleId} conf=${(f.confidence ?? 0).toFixed(2)}  "${f.snippet}"`,
        );
      }
    }
  }

  console.log(
    `\nname-detection: ${nameHits}/${cases.length} hit, ${nameMisses}/${cases.length} miss`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
