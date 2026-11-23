import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { SandboxContainerManager } from '../containers/sandbox-container-manager.js';
import { digest } from '../managed/canonical.js';
import { composeOperatorSandboxTarget } from './operator-sandbox-target.js';

const logger = pino({ level: 'silent' });
const target = {
  subscriptionId: '11b22063-74e3-4e26-ae70-e58690bfd6cc',
  resourceGroup: 'Fixture',
  location: 'northeurope',
  sandboxGroup: 'fixture-private',
};
const scope = JSON.stringify([
  'https://management.northeurope.azuredevcompute.io',
  target.subscriptionId,
  'fixture',
  target.sandboxGroup,
]);
const pin = { resourceScopeDigest: digest(scope), readyDiskImageId: 'ready-fixture-disk' };

it('leaves the ordinary Azure manager alone and binds only the explicit signed target without I/O', () => {
  const network = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', network);
  try {
    const fleet = SandboxContainerManager.withAzureClient(
      { ...target, location: 'swedencentral', sandboxGroup: 'fixture-fleet' },
      logger,
    );
    const before = fleet.executionResourceScope;
    expect(composeOperatorSandboxTarget(undefined, undefined, logger, {})).toBeUndefined();
    const operator = composeOperatorSandboxTarget(JSON.stringify(target), pin, logger, {});
    expect(operator?.executionResourceScope).toBe(scope);
    expect(operator?.readyDiskImageId).toBe(pin.readyDiskImageId);
    expect(fleet.executionResourceScope).toBe(before);
    expect(fleet.executionResourceScope).not.toBe(scope);
    expect(fleet.readyDiskImageId).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('refuses orphaned config, missing exact target, drift and implicit provisioning', () => {
  const raw = JSON.stringify(target);
  expect(() => composeOperatorSandboxTarget(raw, undefined, logger, {})).toThrow(
    'operator-sandbox-target-without-enrollment',
  );
  for (const config of [
    undefined,
    '',
    '{"location":"northeurope"}',
    ' '.repeat(2049),
    JSON.stringify({ ...target, registryCredentials: {} }),
    JSON.stringify({ ...target, assumeGroupExists: false }),
    JSON.stringify({ ...target, location: 'northeurope.example.com/a' }),
    JSON.stringify({ ...target, sandboxGroup: 'other/group' }),
  ]) {
    expect(() => composeOperatorSandboxTarget(config, pin, logger, {})).toThrow(
      'operator-sandbox-target-required',
    );
  }
  for (const changed of [
    { subscriptionId: 'a3feaa9b-9385-4e9c-b1ec-6cb1526c3a70' },
    { resourceGroup: 'Another' },
    { location: 'swedencentral' },
    { sandboxGroup: 'fixture-other' },
  ]) {
    expect(() =>
      composeOperatorSandboxTarget(JSON.stringify({ ...target, ...changed }), pin, logger, {}),
    ).toThrow('parent-sandbox-coding-runtime-mismatch');
  }
});
