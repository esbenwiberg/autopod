import { startParentEvaluatorService } from './parent-evaluator-service.js';

const [config, ...extra] = process.argv.slice(2);
try {
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  if (!config || extra.length || !credentials) throw new Error('service-config-required');
  const server = await startParentEvaluatorService(config, credentials);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  process.stdout.write('parent-evaluator-ready\n');
} catch {
  // Never log inbound source, private paths, or credential loading errors.
  process.stderr.write('parent-evaluator-service-refused\n');
  process.exitCode = 1;
}
