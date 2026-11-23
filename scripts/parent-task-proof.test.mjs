import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyParentTaskProof } from './parent-task-proof.mjs';

// Synthetic Git history and ephemeral fixture keys. No system Git config or credentials.
const tool = fileURLToPath(new URL('./parent-task-proof.mjs', import.meta.url));
const roles = ['checks', 'independentReview'];
let dir;
let bundle;
let pins;
let capture;
let manifest;
let keys;

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  }
  return value;
}
const canonical = (value) => JSON.stringify(sorted(value));
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = (value) => sha(canonical(value));

function finishCapture(draft, retained, { resign = true } = {}) {
  const v = retained.verification;
  v.subjectDigest = digest(retained.subject);
  v.gateRequest.subject = structuredClone(retained.subject);
  v.gateRequest.bundleDigest = retained.bundleDigest;
  v.inputDigest = digest(['autopod.parent-integration-gate.v1', v.gateRequest]);
  for (const role of roles) {
    const { identity, configurationDigest } = v.gatePolicy[role];
    if (resign) {
      const statement = {
        role,
        identity,
        configurationDigest,
        inputDigest: v.inputDigest,
        status: 'passed',
        evidenceDigest: digest(['fictional gate output', role]),
      };
      const receipt = {
        statement,
        signature: sign(
          null,
          Buffer.from(canonical(['autopod.combined-gate.v1', statement])),
          keys[role].privateKey,
        ).toString('base64url'),
      };
      v[role] = { status: 'passed', receiptDigest: digest(receipt), receipt };
    }
  }
  draft.manifest = canonical(retained);
  const core = {
    run: pins.run,
    parentId: pins.parentId,
    evidenceDigest: sha(draft.manifest),
    commit: retained.subject.commit,
    tree: retained.subject.tree,
    bundleDigest: retained.bundleDigest,
    paths: v.gateRequest.paths,
    checks: v.checks.receiptDigest,
    independentReview: v.independentReview.receiptDigest,
  };
  const reviewDigest = digest(['parent-private-review/v1', core]);
  draft.preview = { ...core, reviewDigest };
  draft.approval = {
    review: structuredClone(draft.preview),
    approvalDigest: digest(['parent-private-approval/v1', pins.ownerActorDigest, reviewDigest]),
    approvedAt: 1_700_000_000,
  };
  draft.download = {
    run: core.run,
    parentId: core.parentId,
    evidenceDigest: core.evidenceDigest,
    commit: core.commit,
    httpStatus: 200,
    bundleDigest: core.bundleDigest,
  };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'parent-task-proof-fixture-'));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ALLOW_PROTOCOL: '',
        GIT_AUTHOR_NAME: 'Fiction',
        GIT_AUTHOR_EMAIL: 'author@fixture.invalid',
        GIT_COMMITTER_NAME: 'Fiction',
        GIT_COMMITTER_EMAIL: 'author@fixture.invalid',
        GIT_AUTHOR_DATE: '1700000000 +0000',
        GIT_COMMITTER_DATE: '1700000000 +0000',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--initial-branch=main', '--object-format=sha1', '--template=');
  writeFileSync(join(dir, 'base.txt'), 'Fictional starting point\n');
  git('add', 'base.txt');
  git('commit', '-m', 'Fictional base');
  const sourceCommit = git('rev-parse', 'HEAD');
  const childGit = ['count', 'reason'].map((key) => {
    git('switch', '-c', key, sourceCommit);
    writeFileSync(join(dir, `${key}.txt`), `Fictional ${key}\n`);
    git('add', `${key}.txt`);
    git('commit', '-m', `Fictional ${key} child`);
    return { key, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
  });
  git('switch', '--detach', childGit[0].commit);
  git('merge', '--no-ff', '-m', 'Private parent integration', childGit[1].commit);
  const commit = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  git('bundle', 'create', 'release.bundle', 'HEAD');
  bundle = readFileSync(join(dir, 'release.bundle'));

  keys = Object.fromEntries(roles.map((role) => [role, generateKeyPairSync('ed25519')]));
  const gatePolicy = { basePolicyDigest: digest('fictional base policy') };
  for (const role of roles) {
    gatePolicy[role] = {
      identity: `fictional-${role.toLowerCase()}`,
      configurationDigest: digest(['fictional configuration', role]),
      publicKey: keys[role].publicKey.export({ format: 'jwk' }).x,
    };
  }
  pins = {
    version: 1,
    run: 'trial-one',
    parentId: 'parent-one',
    requestId: 'b0ebe400-0000-4000-a000-000000000000',
    launchDigest: digest('fictional launch').slice(7),
    repository: 'fictional-repository',
    sourceCommit,
    policyDigest: digest(['autopod.combined-policy.v1', gatePolicy]),
    ownerActorDigest: digest('fictional owner'),
    requestKeys: childGit.map((child) => child.key),
  };
  const { run, parentId, requestId, launchDigest, repository, policyDigest } = pins;
  const exit = (podId, attempt, runtimeId, observer) => ({
    run,
    podId,
    attempt,
    runtimeId,
    status: 'observed-exit',
    exitCode: 0,
    observer,
    evidenceDigest: digest(['fictional observed event', runtimeId]),
  });
  const parent = {
    origin: 'task-launch',
    run,
    podId: parentId,
    requestId,
    launchDigest,
    attempt: 'parent-attempt-one',
    generation: 1,
    runtimeId: 'local:parent-container',
    exit: exit(parentId, 'parent-attempt-one', 'local:parent-container', 'daemon-runtime'),
  };
  const children = childGit.map(({ key, commit: newCommit }) => {
    const r = {
      origin: 'parent-runtime',
      run,
      parentId,
      parentAttempt: parent.attempt,
      parentGeneration: parent.generation,
      requestKey: key,
      startKey: `parent-${digest([run, key]).slice(7)}`,
      installationId: `native.${run}`,
      podId: `managed-${key}`,
      attempt: `attempt-${key}`,
      executionSpecDigest: digest(['fictional spec', key]),
      runtimeId: `provider:fictional/${key}`,
    };
    const body = {
      schemaVersion: 1,
      candidateId: `parent-private-${r.podId}`,
      podId: r.podId,
      dispatcherAttemptId: r.attempt,
      executionSpecDigest: r.executionSpecDigest,
      repository,
      remote: 'private',
      head: 'trial/private',
      base: 'main',
      expectedOldCommit: '0'.repeat(40),
      newCommit,
      evidenceDigest: digest(['fictional child bundle bytes', key]),
    };
    return {
      reservation: r,
      exit: exit(r.podId, r.attempt, r.runtimeId, 'provider-runtime'),
      candidate: { ...body, candidateDigest: digest(body) },
    };
  });
  const effects = Object.fromEntries(
    ['push', 'pullRequest', 'merge', 'deploy', 'acceptedSourceAdvance'].map((name) => [
      name,
      { status: 'not-performed', evidenceDigest: digest(['fictional observation', name]) },
    ]),
  );
  capture = { version: 1, parent, children, effects };
  manifest = {
    version: 1,
    subject: { run, repository, predecessor: sourceCommit, commit, tree, policyDigest },
    bundleDigest: sha(bundle),
    verification: {
      gatePolicy,
      gateRequest: {
        inputs: childGit.map(({ key, tree: expectedTree }, index) => ({
          requestKey: key,
          candidateDigest: children[index].candidate.candidateDigest,
          expectedTree,
          scopeDigest: digest([{ kind: 'file', path: `${key}.txt` }]),
        })),
        paths: ['count.txt', 'reason.txt'],
        bindingDigest: digest('fictional authority binding'),
      },
    },
  };
  finishCapture(capture, manifest);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('consistent fixture validates actual Git objects and signatures, never live provenance', () => {
  assert.deepEqual(verifyParentTaskProof(pins, capture, bundle), {
    status: 'consistent',
    provenance: 'not-established',
    liveAcceptance: false,
    commit: manifest.subject.commit,
    tree: manifest.subject.tree,
    bundleDigest: sha(bundle),
  });
});

for (const [name, mutate, error] of [
  [
    'wrong parent launch digest',
    (c) => {
      c.parent.launchDigest = '0'.repeat(64);
    },
    /parent-origin/,
  ],
  [
    'operator-started child',
    (c) => {
      c.children[0].reservation.origin = 'operator';
    },
    /child-origin/,
  ],
  [
    'foreign parent attempt',
    (c) => {
      c.children[0].reservation.parentAttempt = 'different-attempt';
    },
    /child-origin/,
  ],
  [
    'wrong child installation',
    (c) => {
      c.children[0].reservation.installationId = 'native.other';
    },
    /child-origin/,
  ],
  [
    'wrong child start key',
    (c) => {
      c.children[0].reservation.startKey = 'other-key';
    },
    /child-origin/,
  ],
  [
    'no observed parent exit',
    (c) => {
      delete c.parent.exit;
    },
    /parent-origin/,
  ],
  [
    'stop is not a child exit',
    (c) => {
      c.children[0].exit.status = 'stop-requested';
    },
    /child-exit/,
  ],
  [
    'unobserved child code',
    (c) => {
      c.children[0].exit.exitCode = null;
    },
    /child-exit/,
  ],
  [
    'nonzero child exit',
    (c) => {
      c.children[1].exit.exitCode = 1;
    },
    /child-exit/,
  ],
  [
    'exit for a different attempt',
    (c) => {
      c.children[0].exit.attempt = 'different-attempt';
    },
    /child-exit/,
  ],
  [
    'reused observed exit',
    (c) => {
      c.children[0].exit.evidenceDigest = c.children[1].exit.evidenceDigest;
    },
    /duplicate-child-or-exit/,
  ],
  [
    'unbound candidate',
    (c) => {
      c.children[0].candidate.dispatcherAttemptId = 'different-attempt';
    },
    /child-candidate/,
  ],
  [
    'unknown effect',
    (c) => {
      c.effects.push.status = 'unknown';
    },
    /effect-unproven:push/,
  ],
  [
    'unknown effect labeled success',
    (c) => {
      c.effects.deploy.status = 'success';
    },
    /effect-unproven:deploy/,
  ],
  [
    'extra effect labeled success',
    (c) => {
      c.effects.external = { status: 'success' };
    },
    /effect-inventory/,
  ],
  [
    'omitted effect',
    (c) => {
      delete c.effects.merge;
    },
    /effect-inventory/,
  ],
  [
    'missing approval',
    (c) => {
      c.approval = null;
    },
    /review-approval-binding/,
  ],
  [
    'approval of different bytes',
    (c) => {
      c.approval.review.bundleDigest = sha('other bytes');
    },
    /review-approval-binding/,
  ],
  [
    'preview of different tree',
    (c) => {
      c.preview.tree = '0'.repeat(40);
    },
    /review-preview-binding/,
  ],
  [
    'wrong release selector',
    (c) => {
      c.download.parentId = 'other-parent';
    },
    /released-bundle-binding/,
  ],
  [
    'unknown release outcome',
    (c) => {
      c.download.httpStatus = null;
    },
    /released-bundle-binding/,
  ],
]) {
  test(`rejects ${name}`, () => {
    const mutated = structuredClone(capture);
    mutate(mutated);
    assert.throws(() => verifyParentTaskProof(pins, mutated, bundle), error);
  });
}

for (const [name, mutate, error] of [
  [
    'missing review receipt',
    (m) => {
      m.verification.independentReview.receipt = null;
    },
    /gate-receipt:independentReview/,
  ],
  [
    'check receipt substituted for review',
    (m) => {
      m.verification.independentReview = m.verification.checks;
    },
    /gate-receipt:independentReview/,
  ],
  [
    'nonpassing receipt',
    (m) => {
      m.verification.checks.status = 'failed';
    },
    /gate-receipt:checks/,
  ],
  [
    'wrong receipt digest',
    (m) => {
      m.verification.checks.receiptDigest = sha('other receipt');
    },
    /gate-receipt:checks/,
  ],
  [
    'forged signature with recomputed receipt digest',
    (m) => {
      const gate = m.verification.checks;
      gate.receipt.signature = Buffer.alloc(64).toString('base64url');
      gate.receiptDigest = digest(gate.receipt);
    },
    /gate-receipt:checks/,
  ],
  [
    'change in gate inputs without fresh receipts',
    (m) => {
      m.verification.gateRequest.paths.push('other.txt');
    },
    /gate-receipt:checks/,
  ],
]) {
  test(`rejects ${name}`, () => {
    const mutated = structuredClone(capture);
    const retained = structuredClone(manifest);
    mutate(retained);
    finishCapture(mutated, retained, { resign: false });
    assert.throws(() => verifyParentTaskProof(pins, mutated, bundle), error);
  });
}

test('out-of-band source, policy and approval actor pins cannot be substituted', () => {
  for (const [field, value, error] of [
    ['sourceCommit', '1'.repeat(40), /subject-binding/],
    ['policyDigest', sha('different evaluator policy'), /subject-binding/],
    ['ownerActorDigest', sha('different principal'), /review-approval-binding/],
  ]) {
    assert.throws(() => verifyParentTaskProof({ ...pins, [field]: value }, capture, bundle), error);
  }
});

test('rejects unrelated released bytes, even with an otherwise complete capture', () => {
  assert.throws(
    () => verifyParentTaskProof(pins, capture, Buffer.from('unrelated bytes')),
    /released-bundle-bytes/,
  );
});

for (const [name, mutate, error] of [
  [
    'different commit',
    (m) => {
      m.subject.commit = '1'.repeat(40);
    },
    /bundle-head/,
  ],
  [
    'different integrated tree',
    (m) => {
      m.subject.tree = '1'.repeat(40);
    },
    /bundle-commit-tree-or-parents/,
  ],
  [
    'different child tree',
    (m) => {
      m.verification.gateRequest.inputs[1].expectedTree = '1'.repeat(40);
    },
    /bundle-commit-tree-or-parents/,
  ],
]) {
  test(`rejects ${name} even if consistently re-signed`, () => {
    const mutated = structuredClone(capture);
    const retained = structuredClone(manifest);
    mutate(retained);
    finishCapture(mutated, retained);
    assert.throws(() => verifyParentTaskProof(pins, mutated, bundle), error);
  });
}

test('rejects a re-signed selection whose child order does not match the commit parents', () => {
  const mutated = structuredClone(capture);
  const retained = structuredClone(manifest);
  const reversedPins = { ...pins, requestKeys: [...pins.requestKeys].reverse() };
  mutated.children.reverse();
  retained.verification.gateRequest.inputs.reverse();
  finishCapture(mutated, retained);
  assert.throws(
    () => verifyParentTaskProof(reversedPins, mutated, bundle),
    /bundle-commit-tree-or-parents/,
  );
});

test('rejects a corrupt PACK even with correct header and consistently signed digests', () => {
  const broken = Buffer.from(bundle);
  broken[broken.length - 1] ^= 1;
  const mutated = structuredClone(capture);
  const retained = structuredClone(manifest);
  retained.bundleDigest = sha(broken);
  finishCapture(mutated, retained);
  assert.throws(() => verifyParentTaskProof(pins, mutated, broken), /bundle-import/);
});

test('CLI is read-only on capture inputs, cleans its mirror, and exits nonzero on rejected data', () => {
  const pinsPath = join(dir, 'pins.json');
  const capturePath = join(dir, 'capture.json');
  const releasePath = join(dir, 'release.bundle');
  writeFileSync(pinsPath, JSON.stringify(pins));
  writeFileSync(capturePath, JSON.stringify(capture));
  const invoke = () =>
    spawnSync(process.execPath, [tool, pinsPath, capturePath, releasePath], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TMPDIR: dir },
    });
  const originalFiles = readdirSync(dir);
  const ok = invoke();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).liveAcceptance, false);
  assert.deepEqual(readdirSync(dir), originalFiles);
  assert.equal(readFileSync(pinsPath, 'utf8'), JSON.stringify(pins));
  assert.equal(readFileSync(capturePath, 'utf8'), JSON.stringify(capture));
  assert.deepEqual(readFileSync(releasePath), bundle);

  writeFileSync(capturePath, '{');
  const bad = invoke();
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /invalid-json/);
  assert.deepEqual(readdirSync(dir), originalFiles);

  const duplicate = JSON.stringify(capture).replace(
    '"status":"not-performed"',
    '"sta\\u0074us":"unknown","status":"not-performed"',
  );
  writeFileSync(capturePath, duplicate);
  const ambiguous = invoke();
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.stdout, '');
  assert.match(ambiguous.stderr, /duplicate-json-key/);
});
