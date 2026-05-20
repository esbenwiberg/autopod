import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveMobileDist(): string | null {
  const candidates = [
    process.env.AUTOPOD_MOBILE_DIST,
    // dist/api/plugins → ../../../.. → packages/, then into mobile-web/dist.
    // Same relative layout under workspace dev and inside the production image.
    path.join(__dirname, '..', '..', '..', '..', 'mobile-web', 'dist'),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  return null;
}

/**
 * Serves the mobile PWA bundle (`packages/mobile-web/dist`) at `/mobile/*`.
 *
 * The static assets are public — auth is enforced client-side by the SPA, which
 * stores the dev token in localStorage and injects it into REST + WS calls.
 * Routes registered here opt out of the global Bearer-token preHandler via
 * `routeOptions.config.auth = false`.
 *
 * `wildcard: false` keeps unknown paths under `/mobile/*` returning 404 rather
 * than the SPA shell — deep links work via HashRouter (`/mobile/#/pod/abc`),
 * so a server-side catch-all is not needed.
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

  await app.register(async (scope) => {
    scope.addHook('onRoute', (routeOptions) => {
      routeOptions.config = { ...routeOptions.config, auth: false };
    });

    await scope.register(import('@fastify/static'), {
      root: mobileDist,
      prefix: '/mobile/',
      index: ['index.html'],
      decorateReply: false,
      wildcard: false,
    });
  });

  app.log.info({ root: mobileDist }, 'Mobile PWA mounted at /mobile/');
}
