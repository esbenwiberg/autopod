import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { podRoutes } from '../../packages/daemon/src/api/routes/pods.ts';
import { createPodRepository } from '../../packages/daemon/src/pods/pod-repository.ts';
import {
  createTestDb,
  insertTestProfile,
} from '../../packages/daemon/src/test-utils/mock-helpers.ts';
import {
  PAGE_SIZE,
  ROUNDS,
  SIZES,
  TIE_SIZE,
  UNRELATED_MARKER,
  assertPageBudget,
  assertTraversal,
  summarize,
} from './fleet-list-protocol.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const daemonRequire = createRequire(join(root, 'packages/daemon/package.json'));
const Fastify = daemonRequire('fastify');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const command =
  "npx -y -p node@22 -p pnpm@9.15.4 -c 'pnpm --filter @autopod/shared build && AUTOPOD_FLEET_BENCHMARK=1 pnpm exec vitest run --config scripts/benchmarks/fleet-list.config.mjs'";
const statuses = ['running', 'paused', 'awaiting_input', 'complete'];
const epoch = Date.parse('2026-10-15T00:00:00.000Z');
const taskLength = 4_096;
const resultLength = 600;

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
    .sort();
}

function inputHashes() {
  const paths = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'packages/daemon/package.json',
    'packages/shared/package.json',
    'packages/shared/tsup.config.ts',
    ...filesUnder(join(root, 'scripts/benchmarks')).map((path) => relative(root, path)),
    ...filesUnder(join(root, 'packages/daemon/src'))
      .filter((path) => !path.endsWith('.test.ts'))
      .map((path) => relative(root, path)),
    ...filesUnder(join(root, 'packages/shared/src'))
      .filter((path) => !path.endsWith('.test.ts'))
      .map((path) => relative(root, path)),
  ];
  // This workspace package is what daemon source imports resolve to. Hash the
  // actual freshly built output as well as source, rather than assuming HEAD is enough.
  assert.equal(
    realpathSync(join(root, 'packages/daemon/node_modules/@autopod/shared')),
    realpathSync(join(root, 'packages/shared')),
  );
  const sharedDist = filesUnder(join(root, 'packages/shared/dist'));
  assert.ok(sharedDist.some((path) => path.endsWith('/index.js')));
  return {
    source: Object.fromEntries(
      paths.sort().map((path) => [path, sha(readFileSync(join(root, path)))]),
    ),
    sharedDist: Object.fromEntries(
      sharedDist.map((path) => [relative(root, path), sha(readFileSync(path))]),
    ),
  };
}

function evidencePayload(bytes) {
  const skeleton = JSON.stringify({ benchmarkEvidence: UNRELATED_MARKER });
  return JSON.stringify({
    benchmarkEvidence: UNRELATED_MARKER + 'x'.repeat(bytes - skeleton.length),
  });
}

async function makeFixture(size) {
  const db = createTestDb();
  let app;
  try {
    app = Fastify({ logger: false });
    insertTestProfile(db);
    const repo = createPodRepository(db);
    const expected = [];
    const manifest = createHash('sha256');
    const smallEvidence = evidencePayload(64 * 1_024);
    const largeEvidence = evidencePayload(2 * 1_024 * 1_024);
    const fieldSizes = {
      taskChars: taskLength,
      settledResultChars: resultLength,
      unsettledResult: null,
      smallValidationBytes: Buffer.byteLength(smallEvidence),
      largeValidationBytes: Buffer.byteLength(largeEvidence),
      smallValidationRows: Math.floor(size / 100),
      largeValidationRows: 1,
    };
    manifest.update(
      JSON.stringify({ size, pageSize: PAGE_SIZE, tieSize: TIE_SIZE, statuses, fieldSizes }),
    );
    const update = db.prepare(`UPDATE pods SET created_at = ?, updated_at = ?,
      completed_at = ?, pending_escalation = ?, last_validation_result = ? WHERE id = ?`);
    const finalize = db.prepare(`INSERT INTO pod_finalizations
      (pod_id, generation, cycle, phase, agent_settled_at, result, pending_decision_id, source_preserved_at, updated_at)
      VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (let index = 0; index < size; index++) {
        const id = `fleet-${String(index).padStart(6, '0')}`;
        const status = statuses[index % statuses.length];
        const createdAt = new Date(epoch + Math.floor(index / TIE_SIZE) * 1_000).toISOString();
        const task = `Fleet qualification ${id} `.padEnd(taskLength, 't');
        const result =
          status === 'awaiting_input' || status === 'complete'
            ? `Recorded result ${id} `.padEnd(resultLength, 'r')
            : null;
        const question = status === 'awaiting_input' ? `Preserve decision for ${id}?` : null;
        const decisionId = question ? `decision-${id}` : null;
        const decision = question
          ? {
              id: decisionId,
              podId: id,
              type: 'ask_human',
              timestamp: createdAt,
              payload: { question, options: ['Preserve', 'Revise'] },
              response: null,
            }
          : null;
        const finalization = {
          generation: 1,
          cycle: 1,
          phase:
            status === 'awaiting_input'
              ? 'awaiting_human'
              : status === 'complete'
                ? 'finished'
                : 'running',
          agentSettledAt: question || status === 'complete' ? createdAt : null,
          result: result?.slice(0, 500) ?? null,
          resultTruncated: result !== null,
          pendingDecisionId: decisionId,
          sourcePreservedAt: status === 'complete' ? createdAt : null,
        };
        const evidence =
          index === 0 ? largeEvidence : (index + 1) % 100 === 0 ? smallEvidence : null;
        repo.insert({
          id,
          profileName: 'test-profile',
          task,
          status,
          model: 'synthetic',
          runtime: 'codex',
          executionTarget: 'local',
          branch: `fixture/${id}`,
          userId: 'fixture',
          maxValidationAttempts: 3,
          skipValidation: false,
          outputMode: 'pr',
        });
        update.run(
          createdAt,
          createdAt,
          status === 'complete' ? createdAt : null,
          decision ? JSON.stringify(decision) : null,
          evidence,
          id,
        );
        finalize.run(
          id,
          finalization.phase,
          finalization.agentSettledAt,
          result,
          decisionId,
          finalization.sourcePreservedAt,
          createdAt,
        );
        expected.push({
          id,
          status,
          createdAt,
          taskExcerpt: task.slice(0, 2_000),
          title: task.slice(0, 160),
          question,
          finalization,
        });
        // Streaming deterministic input identity; never allocate fleet-wide payload JSON.
        manifest.update(
          JSON.stringify({
            id,
            status,
            createdAt,
            taskSha256: sha(task),
            resultSha256: result === null ? null : sha(result),
            decision,
            finalization,
            validationSha256: evidence ? sha(evidence) : null,
          }),
        );
      }
    })();
    expected.sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    );
    if (size > PAGE_SIZE) {
      assert.equal(
        expected[PAGE_SIZE - 1].createdAt,
        expected[PAGE_SIZE].createdAt,
        'Fixture must exercise a tied timestamp across the first page boundary',
      );
    }
    const counts = db
      .prepare(`SELECT COUNT(*) AS pods, MIN(length(task)) AS minTaskChars,
      MAX(length(task)) AS maxTaskChars,
      SUM(length(CAST(last_validation_result AS BLOB)) = 65536) AS smallValidationRows,
      SUM(length(CAST(last_validation_result AS BLOB)) = 2097152) AS largeValidationRows
      FROM pods`)
      .get();
    assert.equal(counts.pods, size);
    assert.equal(counts.minTaskChars, taskLength);
    assert.equal(counts.maxTaskChars, taskLength);
    assert.equal(counts.smallValidationRows, fieldSizes.smallValidationRows);
    assert.equal(counts.largeValidationRows, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pod_finalizations').get().count, size);
    const manager = {
      getSession: (id) => repo.getOrThrow(id),
      listSessions: (filters) => repo.list(filters),
      getSessionStats: () => repo.getStats(),
    };
    podRoutes(app, manager, undefined, undefined, repo);
    await app.ready();
    return {
      db,
      app,
      expected,
      metadata: {
        size,
        fieldSizes,
        counts,
        inputManifestSha256: manifest.digest('hex'),
        pageCount: db.pragma('page_count', { simple: true }),
        pageSize: db.pragma('page_size', { simple: true }),
        finalizationRows: size,
        tieGroupSize: TIE_SIZE,
        statuses,
      },
    };
  } catch (error) {
    try {
      if (app) await app.close();
    } finally {
      db.close();
    }
    throw error;
  }
}

async function traverse(fixture, observe) {
  const memoryBefore = process.memoryUsage();
  const memorySamples = [];
  const pages = [];
  let cursor;
  const started = performance.now();
  let failure;
  try {
    do {
      const query = new URLSearchParams({
        compact: 'true',
        page: 'true',
        limit: String(PAGE_SIZE),
      });
      if (cursor !== undefined) query.set('cursor', cursor);
      const pageStarted = performance.now();
      const response = await fixture.app.inject({ method: 'GET', url: `/pods?${query}` });
      const body = response.json();
      const elapsedMs = performance.now() - pageStarted;
      cursor = body.nextCursor;
      pages.push({
        statusCode: response.statusCode,
        body,
        elapsedMs,
        bytes: Buffer.byteLength(response.body),
        rawBody: response.body,
      });
      memorySamples.push(process.memoryUsage());
      assertPageBudget(pages.length, cursor, fixture.expected.length);
    } while (cursor !== null);
  } catch (error) {
    failure = error;
  }
  const traversalMs = performance.now() - started;
  const memory = Object.fromEntries(
    ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'].map((field) => {
      const samples = [memoryBefore[field], ...memorySamples.map((sample) => sample[field])];
      return [
        field,
        {
          before: memoryBefore[field],
          after: samples.at(-1),
          sampledMax: Math.max(...samples),
          sampledMaxDelta: Math.max(...samples) - memoryBefore[field],
          endDelta: samples.at(-1) - memoryBefore[field],
        },
      ];
    }),
  );
  const sample = {
    correctnessVerified: false,
    size: fixture.expected.length,
    traversalMs,
    firstPageMs: pages[0]?.elapsedMs ?? null,
    pageCount: pages.length,
    serializedBytes: pages.reduce((sum, page) => sum + page.bytes, 0),
    pages: pages.map(({ elapsedMs, bytes }) => ({ elapsedMs, bytes })),
    memory,
    memorySamples: [memoryBefore, ...memorySamples],
  };
  observe(sample);
  try {
    if (failure) throw failure;
    assertTraversal(pages, fixture.expected);
    sample.correctnessVerified = true;
  } catch (error) {
    sample.error = String(error);
    throw error;
  }
}

it('qualifies warm compact fleet traversal with fixed fixtures and recorded measurements', async () => {
  assert.equal(
    process.env.AUTOPOD_FLEET_BENCHMARK,
    '1',
    `Explicit opt-in required. Run: ${command}`,
  );
  assert.equal(process.versions.node.split('.')[0], '22', 'Use the documented Node 22 command');
  const startedAt = new Date().toISOString();
  const sourceHead = git('rev-parse', 'HEAD');
  const sourceStatus = git('status', '--porcelain');
  const hashes = inputHashes();
  const directory = join(root, '.autopod-data/reliability/r08b');
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `fleet-${sourceHead.slice(0, 12)}-${Date.now()}.json`);
  const fixtures = [];
  const report = {
    version: 1,
    status: 'running',
    command,
    startedAt,
    sourceHead,
    sourceStatus,
    hashes,
    runtime: {
      node: process.version,
      pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
      vitest: daemonRequire('vitest/package.json').version,
      versions: process.versions,
      executableSha256: sha(readFileSync(process.execPath)),
      fastify: daemonRequire('fastify/package.json').version,
      betterSqlite3: daemonRequire('better-sqlite3/package.json').version,
    },
    host: {
      platform: platform(),
      arch: arch(),
      release: release(),
      cpuModel: cpus()[0]?.model,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    protocol: {
      sizes: SIZES,
      pageSize: PAGE_SIZE,
      rounds: ROUNDS,
      allThreeDatabasesResident: true,
      warmupTraversalsPerSize: 1,
      rotation: 'round r starts at sizes[r % 3]',
      timing:
        'page: Fastify inject + JSON decode; traversal: request/decodes, cursor/byte bookkeeping, retained raw and decoded pages and memory sampling; assertions after timing except page cap',
      memory:
        'sampled whole-process values with all fixture DBs resident; not true allocation peaks, retained-memory or leak evidence',
      percentiles: 'nearest rank; seven-sample traversal p95 is max, descriptive only',
      scope:
        'warm in-memory SQLite/repository/Fastify injection; no HTTP transport, disk, UI, concurrent mutation, validation-event workload, SLA or optimization claim; host contention uncontrolled',
    },
    fixtures: [],
    warmups: [],
    samples: [],
  };
  let failure;
  try {
    for (const size of SIZES) {
      const fixture = await makeFixture(size);
      fixtures.push(fixture);
      report.fixtures.push(fixture.metadata);
    }
    for (const fixture of fixtures)
      await traverse(fixture, (sample) => report.warmups.push(sample));
    for (let round = 0; round < ROUNDS; round++) {
      for (let position = 0; position < SIZES.length; position++) {
        const fixture = fixtures[(round + position) % SIZES.length];
        await traverse(fixture, (sample) => {
          sample.round = round;
          sample.position = position;
          report.samples.push(sample);
        });
      }
    }
    assert.equal(report.samples.length, SIZES.length * ROUNDS);
    report.summary = SIZES.map((size) => {
      const samples = report.samples.filter((sample) => sample.size === size);
      assert.equal(samples.length, ROUNDS);
      return {
        size,
        traversalMs: summarize(samples.map((sample) => sample.traversalMs)),
        firstPageMs: summarize(samples.map((sample) => sample.firstPageMs)),
        pageMs: summarize(samples.flatMap((sample) => sample.pages.map((page) => page.elapsedMs))),
        serializedBytes: samples.map((sample) => sample.serializedBytes),
        sampledRssMax: Math.max(...samples.map((sample) => sample.memory.rss.sampledMax)),
        sampledHeapUsedMax: Math.max(...samples.map((sample) => sample.memory.heapUsed.sampledMax)),
      };
    });
    assert.equal(git('rev-parse', 'HEAD'), sourceHead, 'Source HEAD changed during qualification');
    assert.equal(
      git('status', '--porcelain'),
      sourceStatus,
      'Source status changed during qualification',
    );
    assert.deepEqual(inputHashes(), hashes, 'Loaded inputs changed during qualification');
  } catch (error) {
    failure = error;
    report.error = String(error);
  } finally {
    const cleanupErrors = [];
    for (const fixture of fixtures) {
      try {
        try {
          await fixture.app.close();
        } finally {
          fixture.db.close();
        }
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    report.cleanup = {
      closedDatabases: fixtures.filter((fixture) => !fixture.db.open).length,
      errors: cleanupErrors,
    };
    report.finishedAt = new Date().toISOString();
    report.status = failure || cleanupErrors.length ? 'failed' : 'passed';
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(`Fleet qualification receipt: ${relative(root, output)}`);
    if (cleanupErrors.length && !failure) failure = new Error(cleanupErrors.join('\n'));
  }
  if (failure) throw failure;
}, 120_000);
