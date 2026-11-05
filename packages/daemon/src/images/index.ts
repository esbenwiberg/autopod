export { AcrClient, type AcrConfig } from './acr-client.js';
export {
  type DockerfileOptions,
  generateDockerfile,
  getBaseImage,
  getInstallCommand,
} from './dockerfile-generator.js';
export {
  ImageBuilder,
  type ImageBuilderDependencies,
  type ImageBuildResult,
} from './image-builder.js';
export {
  createWarmImageMaintenanceJob,
  DEFAULT_WARM_IMAGE_MAINTENANCE_INTERVAL_MS,
  type WarmImageMaintenanceDeps,
  type WarmImageMaintenanceJob,
  type WarmImageMaintenanceResult,
  type WarmImageMaintenanceScope,
  type WarmImageMaintenanceSkipReason,
} from './warm-image-maintenance.js';
