import type { DaemonReleaseInfo } from '@autopod/shared';
// Embedded at build time. Never infer a release from the daemon's cwd: deployments
// can run from a copied directory while that directory's git checkout moves.
declare const __AUTOPOD_RELEASE__: DaemonReleaseInfo | undefined;
export const daemonRelease: DaemonReleaseInfo =
  typeof __AUTOPOD_RELEASE__ === 'undefined'
    ? { commitSha: null, dirty: null, builtAt: null, source: 'unavailable' }
    : __AUTOPOD_RELEASE__;
