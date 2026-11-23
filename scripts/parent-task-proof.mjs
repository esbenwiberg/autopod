import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const maxBundle = 64 * 1024 * 1024;
const roles = ['checks', 'independentReview'];
const oid = /^[a-f0-9]{40}$/;
const hash = /^sha256:[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const runtimeId = /^[A-Za-z0-9/][A-Za-z0-9._:/-]{0,1023}$/;
const requestKey = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function requireProof(ok, reason) {
  if (!ok) throw new Error(reason);
}

function shape(value, keys, reason) {
  const fields = keys.split(' ');
  requireProof(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      fields.every((field) => Object.hasOwn(value, field)),
    reason,
  );
}

function matches(value, pattern) {
  // JS's $ can match before a terminal newline. Require the entire string.
  return typeof value === 'string' && value.match(pattern)?.[0] === value;
}

function unique(values) {
  return new Set(values).size === values.length;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  requireProof(typeof value !== 'number' || Number.isSafeInteger(value), 'invalid-wire-number');
  return JSON.stringify(value);
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digest(value) {
  return sha256(canonical(value));
}

function wireBytes(value, count) {
  if (typeof value !== 'string' || value.length !== Math.ceil((count * 4) / 3)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === count && bytes.toString('base64url') === value ? bytes : null;
}

function verifyGates(verification, bundleDigest, subject, policyDigest) {
  shape(
    verification,
    'subjectDigest gateRequest inputDigest gatePolicy checks independentReview',
    'gate-verification',
  );
  const { gateRequest, gatePolicy } = verification;
  shape(gateRequest, 'subject inputs paths bindingDigest bundleDigest', 'gate-request');
  shape(gatePolicy, 'basePolicyDigest checks independentReview', 'gate-policy');
  for (const role of roles) {
    const pin = gatePolicy[role];
    shape(pin, 'identity configurationDigest publicKey', 'gate-policy');
    requireProof(
      matches(pin.identity, /^[a-z0-9][a-z0-9._-]{0,127}$/) &&
        matches(pin.configurationDigest, hash) &&
        wireBytes(pin.publicKey, 32),
      'gate-policy',
    );
  }
  requireProof(
    matches(gatePolicy.basePolicyDigest, hash) &&
      gatePolicy.checks.identity !== gatePolicy.independentReview.identity &&
      gatePolicy.checks.publicKey !== gatePolicy.independentReview.publicKey &&
      digest(['autopod.combined-policy.v1', gatePolicy]) === policyDigest,
    'gate-policy',
  );
  const inputDigest = digest(['autopod.parent-integration-gate.v1', gateRequest]);
  requireProof(
    Buffer.byteLength(canonical(gateRequest)) <= 8192 &&
      isDeepStrictEqual(gateRequest.subject, subject) &&
      gateRequest.bundleDigest === bundleDigest &&
      matches(gateRequest.bindingDigest, hash) &&
      verification.subjectDigest === digest(subject) &&
      verification.inputDigest === inputDigest,
    'gate-input-binding',
  );
  for (const role of roles) {
    const result = verification[role];
    const reason = `gate-receipt:${role}`;
    shape(result, 'status receiptDigest receipt', reason);
    shape(result.receipt, 'statement signature', reason);
    const { statement, signature } = result.receipt;
    shape(statement, 'role identity configurationDigest inputDigest status evidenceDigest', reason);
    const pin = gatePolicy[role];
    const bytes = wireBytes(signature, 64);
    requireProof(
      result.status === 'passed' &&
        statement.status === 'passed' &&
        statement.role === role &&
        statement.identity === pin.identity &&
        statement.configurationDigest === pin.configurationDigest &&
        statement.inputDigest === inputDigest &&
        matches(statement.evidenceDigest, hash) &&
        result.receiptDigest === digest(result.receipt) &&
        bytes &&
        verify(
          null,
          Buffer.from(canonical(['autopod.combined-gate.v1', statement])),
          createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: pin.publicKey } }),
          bytes,
        ),
      reason,
    );
  }
  return gateRequest;
}

function observedExit(exit, run, podId, attempt, runtimeId, reason) {
  shape(exit, 'run podId attempt runtimeId status exitCode observer evidenceDigest', reason);
  requireProof(
    exit.run === run &&
      exit.podId === podId &&
      exit.attempt === attempt &&
      exit.runtimeId === runtimeId &&
      exit.status === 'observed-exit' &&
      exit.exitCode === 0 &&
      ['provider-runtime', 'daemon-runtime'].includes(exit.observer) &&
      matches(exit.evidenceDigest, hash),
    reason,
  );
}

function verifyFamily(pins, parent, children, inputs) {
  shape(
    parent,
    'origin run podId requestId launchDigest attempt generation runtimeId exit',
    'parent-origin',
  );
  const { run } = pins;
  requireProof(
    parent.origin === 'task-launch' &&
      parent.run === run &&
      parent.podId === pins.parentId &&
      parent.requestId === pins.requestId &&
      parent.launchDigest === pins.launchDigest &&
      matches(parent.attempt, identifier) &&
      matches(parent.runtimeId, runtimeId) &&
      Number.isSafeInteger(parent.generation) &&
      parent.generation >= 0,
    'parent-origin',
  );
  observedExit(parent.exit, run, parent.podId, parent.attempt, parent.runtimeId, 'parent-exit');
  requireProof(
    Array.isArray(children) &&
      children.length === 2 &&
      Array.isArray(inputs) &&
      inputs.length === 2,
    'child-count',
  );
  const podIds = [parent.podId];
  const attempts = [parent.attempt];
  const runtimes = [parent.runtimeId];
  const exits = [parent.exit.evidenceDigest];
  const startKeys = [];
  const commits = [pins.sourceCommit];
  const selections = children.map((child, index) => {
    shape(child, 'reservation exit candidate', 'child-record');
    const { reservation: r, exit, candidate } = child;
    const input = inputs[index];
    shape(input, 'requestKey candidateDigest expectedTree scopeDigest', 'gate-child-selection');
    shape(
      r,
      'origin run parentId parentAttempt parentGeneration requestKey startKey installationId podId attempt executionSpecDigest runtimeId',
      'child-origin',
    );
    requireProof(
      r.origin === 'parent-runtime' &&
        r.run === run &&
        r.parentId === parent.podId &&
        r.parentAttempt === parent.attempt &&
        r.parentGeneration === parent.generation &&
        r.requestKey === pins.requestKeys[index] &&
        r.requestKey === input.requestKey &&
        r.installationId === `native.${run}` &&
        r.startKey === `parent-${digest([run, r.requestKey]).slice(7)}` &&
        [r.podId, r.attempt].every((id) => matches(id, identifier)) &&
        matches(r.runtimeId, runtimeId) &&
        matches(r.executionSpecDigest, hash),
      'child-origin',
    );
    observedExit(exit, run, r.podId, r.attempt, r.runtimeId, 'child-exit');
    shape(
      candidate,
      'schemaVersion candidateId podId dispatcherAttemptId executionSpecDigest repository remote head base expectedOldCommit newCommit evidenceDigest candidateDigest',
      'child-candidate',
    );
    const { candidateDigest, ...body } = candidate;
    requireProof(
      candidate.schemaVersion === 1 &&
        candidate.candidateId === `parent-private-${r.podId}` &&
        candidate.podId === r.podId &&
        candidate.dispatcherAttemptId === r.attempt &&
        candidate.executionSpecDigest === r.executionSpecDigest &&
        candidate.repository === pins.repository &&
        candidate.remote === 'private' &&
        matches(candidate.head, /^[A-Za-z0-9_./-]{1,160}$/) &&
        matches(candidate.base, /^[A-Za-z0-9_./-]{1,160}$/) &&
        candidate.expectedOldCommit === '0'.repeat(40) &&
        matches(candidate.newCommit, oid) &&
        matches(candidate.evidenceDigest, hash) &&
        candidateDigest === digest(body) &&
        input.candidateDigest === candidateDigest &&
        matches(input.expectedTree, oid) &&
        matches(input.scopeDigest, hash),
      'child-candidate',
    );
    podIds.push(r.podId);
    attempts.push(r.attempt);
    runtimes.push(r.runtimeId);
    exits.push(exit.evidenceDigest);
    startKeys.push(r.startKey);
    commits.push(candidate.newCommit);
    return { commit: candidate.newCommit, tree: input.expectedTree };
  });
  requireProof(
    [podIds, attempts, runtimes, exits, startKeys, commits].every(unique),
    'duplicate-child-or-exit',
  );
  return selections;
}

function verifyRelease(pins, capture, subject, bundleDigest, verification) {
  const { preview, approval, download } = capture;
  const core = {
    run: pins.run,
    parentId: pins.parentId,
    evidenceDigest: sha256(capture.manifest),
    commit: subject.commit,
    tree: subject.tree,
    bundleDigest,
    paths: verification.gateRequest.paths,
    checks: verification.checks.receiptDigest,
    independentReview: verification.independentReview.receiptDigest,
  };
  const reviewDigest = digest(['parent-private-review/v1', core]);
  const review = { ...core, reviewDigest };
  requireProof(isDeepStrictEqual(preview, review), 'review-preview-binding');
  shape(approval, 'review approvalDigest approvedAt', 'review-approval-binding');
  requireProof(
    isDeepStrictEqual(approval.review, review) &&
      approval.approvalDigest ===
        digest(['parent-private-approval/v1', pins.ownerActorDigest, reviewDigest]) &&
      Number.isSafeInteger(approval.approvedAt) &&
      approval.approvedAt > 0,
    'review-approval-binding',
  );
  shape(
    download,
    'run parentId evidenceDigest commit httpStatus bundleDigest',
    'released-bundle-binding',
  );
  requireProof(
    download.run === core.run &&
      download.parentId === core.parentId &&
      download.evidenceDigest === core.evidenceDigest &&
      download.commit === core.commit &&
      download.httpStatus === 200 &&
      download.bundleDigest === bundleDigest,
    'released-bundle-binding',
  );
}

function verifyBundle(bundle, subject, selections) {
  const { commit, tree, predecessor } = subject;
  // Only the daemon's full SHA-1 bundle with one detached HEAD and no prerequisites.
  const header = Buffer.from(`# v2 git bundle\n${commit} HEAD\n\nPACK`);
  requireProof(bundle.subarray(0, header.length).equals(header), 'bundle-head');
  const dir = mkdtempSync(join(tmpdir(), 'parent-task-proof-'));
  // No caller Git config, Git environment, hooks, templates, remotes or checkout.
  const git = (args, failure) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        XDG_CONFIG_HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ALLOW_PROTOCOL: '',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    requireProof(!result.error && result.status === 0, failure);
    return result.stdout.trim();
  };
  try {
    writeFileSync(join(dir, 'release.bundle'), bundle, { flag: 'wx', mode: 0o600 });
    git(['init', '--bare', '--template=', '--object-format=sha1', '.'], 'bundle-git-init');
    requireProof(
      git(['bundle', 'unbundle', 'release.bundle'], 'bundle-import') === `${commit} HEAD`,
      'bundle-head',
    );
    const verifyCommit = (id, expectedTree, parents) => {
      requireProof(
        git(['rev-parse', `${id}^{commit}`, `${id}^{tree}`], 'bundle-commit-tree') ===
          `${id}\n${expectedTree}` &&
          git(['rev-list', '--parents', '-n1', id], 'bundle-commit-parents') ===
            [id, ...parents].join(' '),
        'bundle-commit-tree-or-parents',
      );
    };
    verifyCommit(
      commit,
      tree,
      selections.map((s) => s.commit),
    );
    for (const child of selections) verifyCommit(child.commit, child.tree, [predecessor]);
    git(['fsck', '--strict', '--no-reflogs', '--no-progress', commit], 'bundle-object-integrity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Validates internal consistency of captured statements, not how they were obtained. */
export function verifyParentTaskProof(pins, capture, bundle) {
  shape(
    pins,
    'version run parentId requestId launchDigest repository sourceCommit policyDigest ownerActorDigest requestKeys',
    'expectations',
  );
  requireProof(
    pins.version === 1 &&
      [pins.run, pins.parentId].every((id) => matches(id, identifier)) &&
      matches(pins.requestId, uuid) &&
      matches(pins.launchDigest, /^[a-f0-9]{64}$/) &&
      matches(pins.sourceCommit, oid) &&
      typeof pins.repository === 'string' &&
      pins.repository.length > 0 &&
      pins.repository.length <= 160 &&
      [pins.policyDigest, pins.ownerActorDigest].every((id) => matches(id, hash)) &&
      Array.isArray(pins.requestKeys) &&
      pins.requestKeys.length === 2 &&
      pins.requestKeys.every((key) => matches(key, requestKey)) &&
      unique(pins.requestKeys),
    'expectations',
  );
  shape(capture, 'version parent children manifest preview approval download effects', 'capture');
  requireProof(capture.version === 1, 'capture-version');
  const effectNames = 'push pullRequest merge deploy acceptedSourceAdvance';
  shape(capture.effects, effectNames, 'effect-inventory');
  for (const name of effectNames.split(' ')) {
    const effect = capture.effects[name];
    const reason = `effect-unproven:${name}`;
    shape(effect, 'status evidenceDigest', reason);
    requireProof(effect.status === 'not-performed' && matches(effect.evidenceDigest, hash), reason);
  }
  requireProof(
    typeof capture.manifest === 'string' && Buffer.byteLength(capture.manifest) <= 16384,
    'manifest',
  );
  const manifest = parseJson(capture.manifest);
  shape(manifest, 'version subject bundleDigest verification', 'manifest');
  requireProof(manifest.version === 1 && canonical(manifest) === capture.manifest, 'manifest');
  const { subject, bundleDigest, verification } = manifest;
  shape(subject, 'run repository predecessor commit tree policyDigest', 'subject');
  requireProof(
    subject.run === pins.run &&
      subject.repository === pins.repository &&
      subject.predecessor === pins.sourceCommit &&
      subject.policyDigest === pins.policyDigest &&
      matches(subject.commit, oid) &&
      matches(subject.tree, oid) &&
      subject.commit !== subject.predecessor,
    'subject-binding',
  );
  requireProof(
    Buffer.isBuffer(bundle) &&
      bundle.length > 0 &&
      bundle.length <= maxBundle &&
      sha256(bundle) === bundleDigest,
    'released-bundle-bytes',
  );
  const gate = verifyGates(verification, bundleDigest, subject, pins.policyDigest);
  requireProof(
    Array.isArray(gate.paths) &&
      gate.paths.length > 0 &&
      gate.paths.length <= 2048 &&
      gate.paths.every(
        (path) => typeof path === 'string' && path.length > 0 && path.length <= 4096,
      ) &&
      unique(gate.paths),
    'gate-paths',
  );
  const selections = verifyFamily(pins, capture.parent, capture.children, gate.inputs);
  verifyRelease(pins, capture, subject, bundleDigest, verification);
  verifyBundle(bundle, subject, selections);
  return {
    status: 'consistent',
    provenance: 'not-established',
    liveAcceptance: false,
    commit: subject.commit,
    tree: subject.tree,
    bundleDigest,
  };
}

function parseJson(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('invalid-json');
  }
  // JSON.parse discards duplicate keys. Check the already-valid token stream so
  // another reader cannot see an earlier, contradictory status or receipt.
  const objects = [];
  for (const [token] of source.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}]/g)) {
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (token.endsWith(':')) {
      const key = JSON.parse(token.slice(0, -1));
      const fields = objects.at(-1);
      requireProof(!fields.has(key), 'duplicate-json-key');
      fields.add(key);
    }
  }
  return value;
}

function readInput(path, max) {
  // .json metadata has no filesystem selectors. Only operator-selected files are opened.
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      requireProof(stat.isFile() && stat.size > 0 && stat.size <= max, 'input-size');
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      requireProof(offset === stat.size, 'input-size');
      return bytes.subarray(0, offset);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error('input-unreadable-or-out-of-bounds');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , expectedPath, capturePath, bundlePath, ...extra] = process.argv;
  try {
    requireProof(
      expectedPath && capturePath && bundlePath && extra.length === 0,
      'usage: node scripts/parent-task-proof.mjs EXPECTED.json CAPTURE.json RELEASE.bundle',
    );
    const pins = parseJson(text.decode(readInput(expectedPath, 8192)));
    const capture = parseJson(text.decode(readInput(capturePath, 256 * 1024)));
    const result = verifyParentTaskProof(pins, capture, readInput(bundlePath, maxBundle));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`parent-task-proof: ${error.message}\n`);
    process.exitCode = 1;
  }
}
