import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, vi } from 'vitest';
import type { SidecarManager } from '../containers/sidecar-manager.js';
import {
  createResourceAdvisoryCleanup,
  createResourceAdvisoryState,
} from '../pods/resource-advisory.js';
import { createResourceAuxiliary } from '../pods/resource-auxiliary.js';
import { createResourceCleanup } from '../pods/resource-cleanup.js';
import {
  createResourceCommitPolling,
  createResourceCommitPollingState,
} from '../pods/resource-commit-polling.js';
import type {
  NetworkManager,
  ResourceAuxiliaryLiveDependencies,
  ResourceCleanupLiveDependencies,
  ResourceCommitLiveDependencies,
  ResourceNetworkLiveDependencies,
} from '../pods/resource-contracts.js';
import { createResourceDenials } from '../pods/resource-denials.js';
import { createResourceNetwork } from '../pods/resource-network.js';
import { createResourcePreviewControls } from '../pods/resource-preview-controls.js';
import { createResourcePreviewTimers } from '../pods/resource-preview-timers.js';
import { createResourcePreview } from '../pods/resource-preview.js';
import { createOperatorFixture } from './operator-helpers.js';
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
export const result = (stdout = '', exitCode = 0) => ({ stdout, stderr: '', exitCode });
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
export function createResourceFixture(disk = false) {
  const f = createOperatorFixture(disk);
  vi.spyOn(f.deps.logger, 'warn');
  const core = { ...f.mainCaptured, ...f.guards };
  const live: ResourceCleanupLiveDependencies &
    ResourceAuxiliaryLiveDependencies &
    ResourceNetworkLiveDependencies &
    ResourceCommitLiveDependencies = {};
  const sidecars = {
    spawn: vi.fn<SidecarManager['spawn']>(),
    waitHealthy: vi.fn<SidecarManager['waitHealthy']>(),
    kill: vi.fn<SidecarManager['kill']>(async () => {}),
    getBridgeIp: vi.fn<SidecarManager['getBridgeIp']>(async () => '172.22.0.4'),
    reconcileOrphans: vi.fn<SidecarManager['reconcileOrphans']>(async () => 0),
  };
  const network = {
    getGatewayIp: vi.fn<NetworkManager['getGatewayIp']>(async () => '172.22.0.1'),
    buildNetworkConfig: vi.fn<NetworkManager['buildNetworkConfig']>(async () => ({
      networkName: 'synthetic',
      firewallScript: 'synthetic firewall',
    })),
    destroyNetworkForPod: vi.fn<NonNullable<NetworkManager['destroyNetworkForPod']>>(
      async () => {},
    ),
  };
  const preview = createResourcePreview(core);
  const cleanupCaptured = {
    ...core,
    stopSandboxPreviewProxy: vi.fn(preview.stopSandboxPreviewProxy),
    stopHaproxyDenyReceiver: vi.fn(async () => {}),
    forgetMaxCredentialLineage: vi.fn(),
  };
  const cleanup = createResourceCleanup(live, cleanupCaptured);
  const auxiliaryCaptured = { ...core, sidecarManager: sidecars };
  const networkCaptured = {
    ...core,
    profileStore: f.profiles,
    providerAccountStore: f.accounts,
    providerCatalog: undefined,
    daemonConfig: f.deps.daemonConfig,
    mcpBaseUrl: 'http://daemon.internal:3210',
    sidecarManager: sidecars,
    networkManager: network,
  };
  const timers = createResourcePreviewTimers({
    ...core,
    stopSandboxPreviewProxy: cleanupCaptured.stopSandboxPreviewProxy,
  });
  const commitState = createResourceCommitPollingState(core);
  const commitCaptured = { ...core, ...commitState };
  const commit = createResourceCommitPolling(live, commitCaptured);
  const advisory = createResourceAdvisoryState();
  const controlsCaptured = {
    ...core,
    ensureSandboxPreviewProxy: preview.ensureSandboxPreviewProxy,
    ...timers,
    stopSandboxPreviewProxy: cleanupCaptured.stopSandboxPreviewProxy,
  };
  const controls = createResourcePreviewControls(controlsCaptured);
  closes.push(async () => {
    commit.stopCommitPolling('prepare');
    timers.clearPreviewTimer('prepare');
    await preview.stopSandboxPreviewProxy('prepare');
  });
  const sandbox = () => {
    f.podRepo.update('prepare', { containerId: null });
    f.podRepo.update('prepare', { executionTarget: 'sandbox' });
    f.podRepo.update('prepare', { containerId: 'container-123' });
  };
  return {
    ...f,
    sandbox,
    get db() {
      return f.db;
    },
    core,
    live,
    sidecars,
    network,
    preview,
    cleanupCaptured,
    cleanup,
    auxiliaryCaptured,
    networkCaptured,
    timers,
    commit,
    commitCaptured,
    advisory,
    controls,
    controlsCaptured,
    auxiliary: () => createResourceAuxiliary(live, auxiliaryCaptured),
    networkOwner: () => createResourceNetwork(live, networkCaptured),
    advisoryCleanup: () => createResourceAdvisoryCleanup({ ...core, ...advisory, ...cleanup }),
    denials: () => createResourceDenials(core),
  };
}

export async function unusedLocalPreviewUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return `http://127.0.0.1:${port}`;
}
