// Offline package/protocol check. Install the two pinned packages into a disposable
// npm prefix first, then pass that prefix. Never inherit provider credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

assert.ok(process.argv[2], 'Usage: node scripts/check-gpt62-runtime-packages.mjs NPM_PREFIX');
const prefix = path.resolve(process.argv[2]);
const root = mkdtempSync(path.join(tmpdir(), 'autopod-gpt62-check-'));
const ids = ['gpt-6.2-sol', 'gpt-6.2-astra'];
mkdirSync(path.join(root, 'codex'));
const env = {
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: root,
  CODEX_HOME: path.join(root, 'codex'),
  PI_CODING_AGENT_DIR: path.join(root, 'pi'),
  PI_OFFLINE: '1',
  PI_TELEMETRY: '0',
};
const cli = (name) => path.join(prefix, 'node_modules', '.bin', name);
const run = (name, args, input) => {
  const result = spawnSync(cli(name), args, {
    env,
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `${name}: ${result.error ?? result.stderr}`);
  return result.stdout;
};

try {
  assert.equal(run('codex', ['--version']).trim(), 'codex-cli 0.171.0');
  assert.equal(run('pi', ['--version']).trim(), '1.6.0');
  for (const provider of ['openai', 'openai-codex']) {
    for (const id of ids) {
      const output = run(
        'pi',
        [
          '--mode',
          'rpc',
          '--offline',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-mcp',
          '--no-context-files',
          '--model',
          `${provider}/${id}`,
        ],
        '{"id":"state","type":"get_state"}\n',
      );
      const response = output
        .trim()
        .split('\n')
        .map(JSON.parse)
        .find((r) => r.id === 'state');
      assert.equal(response?.success, true);
      assert.equal(response.data.model.id, id);
      assert.equal(response.data.model.provider, provider);
      assert.equal(response.data.model.name, id.endsWith('sol') ? 'GPT-6.2 Sol' : 'GPT-6.2 Astra');
      console.log(`PASS Pi native RPC/catalog ${provider}/${id}`);
    }
  }
  await new Promise((resolve, reject) => {
    const child = spawn(cli('codex'), ['app-server'], { env, cwd: root });
    let buffer = '';
    let stderr = '';
    let received = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Codex model/list timed out: ${stderr.slice(0, 1000)}`));
    }, 20_000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (received && code === 0) resolve();
      else
        reject(
          new Error(`Codex exited ${code} before catalog verification: ${stderr.slice(0, 1000)}`),
        );
    });
    const send = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let lf = buffer.indexOf('\n');
      while (lf >= 0) {
        const line = buffer.slice(0, lf);
        buffer = buffer.slice(lf + 1);
        try {
          const record = JSON.parse(line);
          if (record.id === 1) {
            assert.ok(record.result);
            send({ method: 'initialized' });
            send({ id: 2, method: 'model/list', params: { includeHidden: true } });
          }
          if (record.id === 2) {
            for (const id of ids)
              assert.ok(
                record.result?.data.some((model) => model.id === id),
                id,
              );
            received = true;
            console.log(`PASS Codex initialize/model/list ${ids.join(', ')}`);
            child.stdin.end();
          }
        } catch (error) {
          child.kill('SIGKILL');
          reject(error);
        }
        lf = buffer.indexOf('\n');
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'autopod-runtime-check', version: '1' } },
    });
  });
  console.log('PASS pinned versions and credential-free native protocols (no inference)');
} finally {
  rmSync(root, { recursive: true, force: true });
}
