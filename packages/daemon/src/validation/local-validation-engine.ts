import type { ValidationResult } from '@autopod/shared';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ValidationEngine, ValidationEngineConfig } from '../interfaces/validation-engine.js';

/**
 * MVP validation engine: build-only.
 *
 * Runs the build command via containerManager.execInContainer.
 * Health check, page validation, and task review are skipped for local-first MVP.
 */
export function createLocalValidationEngine(containerManager: ContainerManager): ValidationEngine {
  return {
    async validate(config: ValidationEngineConfig): Promise<ValidationResult> {
      const startTime = Date.now();

      // Run build command
      let buildStatus: 'pass' | 'fail' = 'pass';
      let buildOutput = '';
      let buildDuration = 0;

      if (config.buildCommand) {
        const buildStart = Date.now();
        const result = await containerManager.execInContainer(
          config.containerId,
          ['sh', '-c', config.buildCommand],
          { cwd: '/workspace', timeout: 120_000 },
        );
        buildDuration = Date.now() - buildStart;
        buildOutput = (result.stdout + '\n' + result.stderr).trim();

        if (result.exitCode !== 0) {
          buildStatus = 'fail';
        }
      }

      const overall = buildStatus;
      const duration = Date.now() - startTime;

      return {
        sessionId: config.sessionId,
        attempt: config.attempt,
        timestamp: new Date().toISOString(),
        smoke: {
          status: buildStatus,
          build: {
            status: buildStatus,
            output: buildOutput.slice(0, 10_000), // Cap output size
            duration: buildDuration,
          },
          health: {
            status: 'pass', // Skip health check for local MVP
            url: config.previewUrl,
            responseCode: null,
            duration: 0,
          },
          pages: [], // Skip page validation for local MVP
        },
        taskReview: null, // Skip task review for local MVP
        overall,
        duration,
      };
    },
  };
}
