#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_PATHS = [
  /^pnpm-lock\.yaml$/,
  /^report\.html$/,
  /^website\//,
  /^docs\//,
  /^specs\//,
  /^skills\//,
  /^\.agents\//,
  /^\.claude\/skills\//,
  /\.test\.[cm]?[jt]s$/,
];

const RULES = [
  {
    name: 'GitHub token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b/g,
    allow: (value) => /(?:test|fake|example|xxx|\.\.\.)/i.test(value) || repeatedBody(value, '_'),
  },
  {
    name: 'GitHub fine-grained token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
    allow: (value) => /(?:test|fake|example|xxx|\.\.\.)/i.test(value),
  },
  {
    name: 'OpenAI-style key',
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/g,
    allow: (value) => /(?:sk-test|sk-ant-test|fake|example|\.\.\.)/i.test(value),
  },
  {
    name: 'AWS access key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    allow: (value) => /EXAMPLE/i.test(value),
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
    allow: () => false,
  },
];

function repeatedBody(value, separator) {
  const body = value.slice(value.indexOf(separator) + 1);
  return body.length > 0 && new Set(body).size === 1;
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(result.stderr.trim() || 'Unable to list tracked files.');
    process.exit(result.status ?? 1);
  }
  return result.stdout.split('\0').filter(Boolean);
}

function shouldSkip(path) {
  return SKIP_PATHS.some((pattern) => pattern.test(path));
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

const findings = [];

for (const file of trackedFiles()) {
  if (shouldSkip(file)) continue;

  let source;
  try {
    const buffer = readFileSync(file);
    if (buffer.includes(0) || buffer.byteLength > MAX_FILE_BYTES) continue;
    source = buffer.toString('utf8');
  } catch {
    continue;
  }

  for (const rule of RULES) {
    for (const match of source.matchAll(rule.pattern)) {
      const value = match[0];
      if (rule.allow(value)) continue;
      findings.push(`${file}:${lineNumber(source, match.index ?? 0)} ${rule.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Secret scan found high-confidence findings:');
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log('Secret scan passed.');
