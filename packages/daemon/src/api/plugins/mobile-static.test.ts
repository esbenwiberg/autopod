import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mobileStaticPlugin } from './mobile-static.js';

describe('mobileStaticPlugin', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  const originalDistEnv = process.env.AUTOPOD_MOBILE_DIST;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopod-mobile-static-'));
  });

  afterEach(async () => {
    await app?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env.AUTOPOD_MOBILE_DIST = originalDistEnv;
  });

  it('serves index.html at /mobile/', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html><title>autopod</title>');
    process.env.AUTOPOD_MOBILE_DIST = tmpDir;

    app = Fastify();
    await mobileStaticPlugin(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/mobile/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<title>autopod</title>');
  });

  it('serves arbitrary files in the dist root', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(tmpDir, 'manifest.webmanifest'), '{"name":"Autopod"}');
    process.env.AUTOPOD_MOBILE_DIST = tmpDir;

    app = Fastify();
    await mobileStaticPlugin(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/mobile/manifest.webmanifest' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"name":"Autopod"}');
  });

  it('serves nested built asset files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html>');
    fs.mkdirSync(path.join(tmpDir, 'assets'));
    fs.writeFileSync(path.join(tmpDir, 'assets', 'index-test.js'), 'console.log("ok");');
    process.env.AUTOPOD_MOBILE_DIST = tmpDir;

    app = Fastify();
    await mobileStaticPlugin(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/mobile/assets/index-test.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe('console.log("ok");');
  });

  it('returns 404 for unknown paths (HashRouter — no SPA-shell fallback)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<!doctype html>');
    process.env.AUTOPOD_MOBILE_DIST = tmpDir;

    app = Fastify();
    await mobileStaticPlugin(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/mobile/does-not-exist.js' });
    expect(res.statusCode).toBe(404);
  });

  it('skips the mount with a warning when the dist dir is missing', async () => {
    process.env.AUTOPOD_MOBILE_DIST = path.join(tmpDir, 'does-not-exist');

    const warnings: unknown[] = [];
    app = Fastify({ logger: false });
    app.log.warn = ((obj: unknown) => warnings.push(obj)) as typeof app.log.warn;
    await mobileStaticPlugin(app);
    await app.ready();

    expect(warnings.length).toBeGreaterThan(0);
    const res = await app.inject({ method: 'GET', url: '/mobile/' });
    expect(res.statusCode).toBe(404);
  });
});
