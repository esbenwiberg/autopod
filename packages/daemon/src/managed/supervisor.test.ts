import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it.each(['expired', 'revoked', 'budget-exhausted', 'request-time-expired', 'request-time-stale'])(
  'supervisor enforces %s after its caller exits, with no duplicate launch',
  async (reason) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-supervisor-')));
    const script = path.resolve(import.meta.dirname, 'runtime/supervisor.py');
    const now = 100;
    const spec = {
      expiresAt: now + 30,
      maxDurationSeconds: 30,
      specDigest: 'fixture-digest',
      ...(reason.startsWith('request-time') ? { budgetMode: 'request-time' } : { maxTokens: 10 }),
      requireQuotaReceipt: reason === 'budget-exhausted' || reason.startsWith('request-time'),
      workerUid: process.getuid?.(),
      workerGid: process.getgid?.(),
      environment: { PATH: '/usr/bin:/bin', HOME: root },
      cwd: root,
      argv: [
        '/usr/bin/python3',
        '-c',
        "from pathlib import Path; import time; p=Path('count'); p.write_text(str(int(p.read_text())+1) if p.exists() else '1'); time.sleep(15)",
      ],
    };
    await writeFile(path.join(root, 'clock'), String(now));
    const detached = `import os,sys,runpy,pathlib
if os.fork(): sys.exit(0)
os.setsid()
if os.fork(): os._exit(0)
with open(os.devnull,'rb',0) as i,open(os.devnull,'ab',0) as o:
 os.dup2(i.fileno(),0);os.dup2(o.fileno(),1);os.dup2(o.fileno(),2)
r=pathlib.Path(sys.argv[2]);runpy.run_path(sys.argv[1])['supervise'](r,lambda:float((r/'clock').read_text()))
`;
    await writeFile(path.join(root, 'launch.json'), JSON.stringify(spec));
    await writeFile(
      path.join(root, 'quota.json'),
      JSON.stringify({
        specDigest: spec.specDigest,
        consumedTokens: reason.startsWith('request-time') ? 6000 : 0,
        observedAt: now,
      }),
    );
    try {
      execFileSync('/usr/bin/python3', ['-c', detached, script, root]);
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        try {
          if ((await readFile(path.join(root, 'count'), 'utf8')) === '1') break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      execFileSync('/usr/bin/python3', ['-c', detached, script, root]);
      if (reason.startsWith('request-time')) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(
          JSON.parse(await readFile(path.join(root, 'execution.json'), 'utf8')).observedExit,
        ).toBe(false);
        if (reason === 'request-time-expired')
          await writeFile(
            path.join(root, 'quota.json'),
            JSON.stringify({
              specDigest: spec.specDigest,
              consumedTokens: 6000,
              observedAt: now + 31,
            }),
          );
        await writeFile(
          path.join(root, 'clock'),
          String(now + (reason === 'request-time-stale' ? 6 : 31)),
        );
      }
      if (reason === 'expired') await writeFile(path.join(root, 'clock'), String(now + 31));
      if (reason === 'revoked') await writeFile(path.join(root, 'revoked'), 'true');
      if (reason === 'budget-exhausted')
        await writeFile(
          path.join(root, 'quota.json'),
          JSON.stringify({ specDigest: spec.specDigest, consumedTokens: 10, observedAt: now }),
        );
      let receipt: { observedExit?: boolean; state?: string } = {};
      while (Date.now() < deadline) {
        receipt = JSON.parse(await readFile(path.join(root, 'execution.json'), 'utf8'));
        if (receipt.observedExit) break;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      expect(receipt).toMatchObject({
        observedExit: true,
        state:
          reason === 'request-time-stale'
            ? 'quota-unavailable'
            : reason === 'request-time-expired'
              ? 'expired'
              : reason,
      });
      expect(await readFile(path.join(root, 'count'), 'utf8')).toBe('1');
    } finally {
      await writeFile(path.join(root, 'revoked'), 'true').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
