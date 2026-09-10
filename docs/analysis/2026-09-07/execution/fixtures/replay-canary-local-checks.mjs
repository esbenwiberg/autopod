import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Historical tests replace exact text in their executed runner. Replay those
// immutable inputs while allowing maintained source copies to follow repo style.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'receipts/checkpoint-131-executed-inputs/manifest.json'), 'utf8'),
);
const [test, runner] = process.argv.slice(2);
if (!manifest[`fixtures/${test}`] || !manifest[`fixtures/${runner}`]) {
  throw new Error('Select a recorded local test and runner');
}
const readFile = fs.readFileSync;
fs.readFileSync = (file, ...options) => {
  const filename = file instanceof URL ? fileURLToPath(file) : file;
  if (typeof filename === 'string') {
    const relative = path.relative(root, path.resolve(filename));
    const entry = manifest[relative];
    if (entry) return readFile(path.join(root, entry.archive), ...options);
  }
  return readFile(file, ...options);
};
const testPath = path.join(root, 'fixtures', test);
process.argv = [process.argv[0], testPath, path.join(root, 'fixtures', runner)];
await import(pathToFileURL(testPath).href);
