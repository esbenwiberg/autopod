// Executed only inside the dedicated no-network, unprivileged renderer container.
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const origin = 'https://reference.invalid';
const viewport = { width: 1280, height: 900 };
let stage = 'input';
const deadline = setTimeout(() => {
  process.stderr.write(`REFERENCE_RENDER_TIMEOUT:${stage}`);
  process.exit(124);
}, 24_000);
let browser;
(async () => {
  const job = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > 36 * 1024 * 1024) {
        reject(new Error('job too large'));
        process.stdin.pause();
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(10)) {
        process.stdin.pause();
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('invalid job'));
        }
      }
    });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => reject(new Error('incomplete job')));
  });
  if (!job || job.protocol !== 1 || job.files.length > 50) throw new Error('invalid job');
  const resources = new Map();
  let total = 0;
  for (const file of job.files) {
    if (
      path.posix.normalize(file.path) !== file.path ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => part.startsWith('.'))
    )
      throw new Error('unsafe path');
    const bytes = Buffer.from(file.base64, 'base64');
    total += bytes.length;
    if (
      total > 25 * 1024 * 1024 ||
      bytes.length !== file.byteLength ||
      sha256(bytes) !== file.sha256
    )
      throw new Error('input mismatch');
    resources.set(file.path, { file, bytes });
  }
  const entry = resources.get(job.entrypoint);
  if (!entry || entry.file.mediaType !== 'text/html') throw new Error('not html');
  let blockedRequests = 0;
  let scriptErrors = 0;
  const resourceSha256s = new Set();
  stage = 'browser';
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--renderer-process-limit=2'],
  });
  stage = 'context';
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const csp =
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin";
  await context.route('**/*', async (route) => {
    try {
      const url = new URL(route.request().url());
      const relative = decodeURIComponent(url.pathname.slice(1));
      const resource =
        url.origin === origin && route.request().method() === 'GET'
          ? resources.get(relative)
          : undefined;
      if (!resource) {
        blockedRequests++;
        await route.abort();
        return;
      }
      resourceSha256s.add(resource.file.sha256);
      await route.fulfill({
        status: 200,
        body: resource.bytes,
        contentType: resource.file.mediaType,
        headers: {
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      blockedRequests++;
      await route.abort().catch(() => {});
    }
  });
  await context.routeWebSocket('**/*', (socket) => {
    blockedRequests++;
    socket.close();
  });
  const page = await context.newPage();
  page.on('pageerror', () => {
    scriptErrors++;
  });
  context.on('page', (popup) => {
    if (popup !== page) popup.close().catch(() => {});
  });
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  page.on('requestfailed', () => {
    blockedRequests++;
  });
  let escaped = false;
  let entrySeen = false;
  const entryUrl = `${origin}/${job.entrypoint.split('/').map(encodeURIComponent).join('/')}`;
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    if (!entrySeen && frame.url() === 'about:blank') return;
    const url = new URL(frame.url());
    if (url.origin !== origin || url.pathname !== new URL(entryUrl).pathname) {
      escaped = true;
      page.close().catch(() => {});
    } else entrySeen = true;
  });
  stage = 'navigation';
  await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
  await page.evaluate(() =>
    Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 1000))]),
  );
  stage = 'screenshot';
  const bytes = await page.screenshot({
    type: 'jpeg',
    quality: 80,
    fullPage: false,
    animations: 'disabled',
    caret: 'hide',
    timeout: 5000,
  });
  if (escaped || bytes.length > 2 * 1024 * 1024) throw new Error('invalid output');
  const receipt = {
    bundleDigest: job.bundleDigest,
    sourceSha256: entry.file.sha256,
    resourceSha256s: [...resourceSha256s].sort(),
    entrypoint: job.entrypoint,
    rendererImage: job.rendererImage,
    rendererProtocol: 1,
    browserVersion: browser.version(),
    ...viewport,
    mediaType: 'image/jpeg',
    jpegQuality: 80,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    blockedRequests: Math.min(blockedRequests, 1_000_000),
    scriptErrors: Math.min(scriptErrors, 1_000_000),
    capturedAt: new Date().toISOString(),
  };
  stage = 'output';
  await new Promise((resolve, reject) =>
    process.stdout.write(JSON.stringify({ receipt, base64: bytes.toString('base64') }), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
})()
  .catch(() => {
    // Never print URLs, DOM, source text or user console messages into Docker/daemon logs.
    process.stderr.write(`REFERENCE_RENDER_FAILED:${stage}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    stage = 'cleanup';
    if (browser) await browser.close().catch(() => {});
    clearTimeout(deadline);
    process.stdin.destroy();
  });
