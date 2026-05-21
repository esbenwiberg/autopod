import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveMobileDist(): string | null {
  // tsup bundles the daemon flat — the runtime `__dirname` is
  // `packages/daemon/dist/`, so `../../` lands at `packages/`. Same relative
  // layout in workspace dev and inside the production Docker image.
  const candidates = [
    process.env.AUTOPOD_MOBILE_DIST,
    path.join(__dirname, '..', '..', 'mobile-web', 'dist'),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  return null;
}

/**
 * Serves the mobile PWA bundle (`packages/mobile-web/dist`) at `/mobile/*`.
 *
 * Static assets are public — the auth plugin bypasses the `/mobile/` prefix
 * (see `auth.ts`). The SPA itself enforces auth client-side using the dev
 * token paired via the `ap mobile pair` QR flow.
 *
 * Deep links work via HashRouter (`/mobile/#/pod/abc`), so a server-side
 * SPA-shell catch-all is not needed. Unknown asset paths still return a
 * clean 404 from @fastify/static.
 *
 * Mount is skipped (with a warn log) when the dist dir is missing, so the
 * daemon stays usable when the PWA hasn't been built.
 */
export async function mobileStaticPlugin(app: FastifyInstance): Promise<void> {
  const mobileDist = resolveMobileDist();
  if (!mobileDist) {
    app.log.warn(
      'mobile-web dist not found — /mobile/* will not be served. ' +
        'Set AUTOPOD_MOBILE_DIST or build packages/mobile-web first.',
    );
    return;
  }

  await app.register(import('@fastify/static'), {
    root: mobileDist,
    prefix: '/mobile/',
    index: ['index.html'],
    decorateReply: false,
  });

  app.log.info({ root: mobileDist }, 'Mobile PWA mounted at /mobile/');
}
