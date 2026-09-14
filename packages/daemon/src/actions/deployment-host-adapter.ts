import type { EffectiveLaunchConfig } from '@autopod/shared';
import type Dockerode from 'dockerode';
import type { Logger } from 'pino';
import { configurationError } from '../configuration/configuration-store.js';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import type { DockerNetworkManager } from '../containers/docker-network-manager.js';
import type { DeploymentRun } from './deployment-run-repository.js';
import { type DeploymentTarget, deploymentTargetSchema } from './deployment-service.js';
import { IsolatedDeployRunner, type IsolatedDeploymentInput } from './isolated-deploy-runner.js';

/** The only composed deployment execution path. Never mounts a checkout or invokes a host shell. */
export function createDeploymentHostAdapter(options: {
  docker: Dockerode;
  network?: Pick<DockerNetworkManager, 'buildNetworkConfig' | 'removeNetworkForPod'>;
  logger: Logger;
  targets: readonly DeploymentTarget[];
}) {
  const targets = options.targets.map((target) => deploymentTargetSchema.parse(target));
  const manager = new DockerContainerManager(options);
  const networkKey = (runId: string) => `deploy-${runId}`;
  return {
    target(config: EffectiveLaunchConfig) {
      const selected = targets.find(
        (target) => target.id === config.repository?.setup.integrations.deployment?.targetId,
      );
      if (!selected || (selected.allowedHosts.length > 0 && !options.network))
        configurationError(
          'Deployment target or isolated network is unavailable',
          'DEPLOYMENT_ISOLATION_UNAVAILABLE',
          503,
        );
      return structuredClone(selected);
    },
    async run(target: DeploymentTarget, input: IsolatedDeploymentInput) {
      const network = options.network;
      const runner = new IsolatedDeployRunner({
        ...target,
        docker: options.docker,
        logger: options.logger,
        network:
          target.allowedHosts.length && network
            ? {
                async create(runId) {
                  try {
                    const result = await network.buildNetworkConfig(
                      {
                        enabled: true,
                        mode: 'restricted',
                        allowedHosts: target.allowedHosts,
                        replaceDefaults: true,
                      },
                      [],
                      '127.0.0.1',
                      [],
                      networkKey(runId),
                      [],
                      [],
                      3100,
                      false,
                    );
                    if (!result) throw new Error('Deployment network was not configured');
                    return {
                      name: result.networkName,
                      configure: (id) => manager.refreshFirewall(id, result.firewallScript),
                    };
                  } catch {
                    await network.removeNetworkForPod(networkKey(runId));
                    throw new Error('Deployment network preparation failed');
                  }
                },
                destroy: () => network.removeNetworkForPod(networkKey(input.runId)),
              }
            : undefined,
      });
      return runner.run(input);
    },
    async stop(run: DeploymentRun) {
      // Labels cover a crash between Docker create and persisting its returned container ID.
      const containers = await options.docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`autopod.deployment-run=${run.id}`] }),
      });
      for (const container of containers) {
        if (container.Labels['autopod.deployment-run'] !== run.id)
          throw new Error('Deployment recovery ownership mismatch');
        await options.docker.getContainer(container.Id).remove({ force: true, v: true });
      }
      if (run.containerId) {
        try {
          const observed = await options.docker.getContainer(run.containerId).inspect();
          if (observed.Config.Labels?.['autopod.deployment-run'] !== run.id)
            throw new Error('Deployment recovery ownership mismatch');
          await options.docker.getContainer(run.containerId).remove({ force: true, v: true });
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        }
      }
      await options.network?.removeNetworkForPod(networkKey(run.id));
    },
  };
}
