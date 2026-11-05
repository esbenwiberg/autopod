import { AutopodError, inputPathSchema, MAX_INPUT_FILE_BYTES } from '@autopod/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InputBundleStore } from '../../inputs/input-bundle-store.js';
import type { ReferencePreviewService } from '../../inputs/reference-preview-service.js';
import { errorHandler } from '../error-handler.js';

/** Operator-only, owner-scoped input uploads. Never serve active HTML in the daemon origin. */
export async function inputBundleRoutes(
  app: FastifyInstance,
  store: InputBundleStore,
  previews?: ReferencePreviewService,
): Promise<void> {
  await app.register(async (scope) => {
    scope.setErrorHandler<FastifyError>((error, request, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
        return reply.code(413).send({
          error: 'INPUT_TOO_LARGE',
          message: 'Attachment exceeds the 10 MiB upload limit',
        });
      return errorHandler(error, request, reply);
    });
    // Bound buffering before body parsing, including unauthenticated requests.
    let uploads = 0;
    const admitted = new WeakSet<object>();
    scope.addHook('onRequest', async (request) => {
      if (request.method !== 'PUT') return;
      if (uploads >= 4)
        throw new AutopodError(
          'Too many attachment uploads; retry shortly',
          'INPUT_UPLOAD_BUSY',
          429,
        );
      admitted.add(request);
      uploads++;
    });
    const release = async (request: object) => {
      if (admitted.delete(request)) uploads--;
    };
    scope.addHook('onResponse', release);
    scope.addHook('onRequestAbort', release);
    scope.addHook('onTimeout', release);
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_INPUT_FILE_BYTES },
      (_request, body, done) => done(null, body),
    );
    scope.post('/input-bundles', async (request, reply) => {
      const bundle = store.create(request.body, request.user.oid);
      return reply.code(201).send(bundle);
    });
    scope.get('/input-bundles/:id', async (request) => {
      const { id } = request.params as { id: string };
      return store.get(id, request.user.oid);
    });
    scope.put(
      '/input-bundles/:id/files/:index',
      { bodyLimit: MAX_INPUT_FILE_BYTES },
      async (request, reply) => {
        const { id, index } = request.params as { id: string; index: string };
        if (!/^\d{1,2}$/.test(index) || !Buffer.isBuffer(request.body))
          throw new AutopodError(
            'Send raw attachment bytes as application/octet-stream',
            'INVALID_INPUT_UPLOAD',
            400,
          );
        store.put(id, request.user.oid, Number(index), request.body);
        return reply.code(204).send();
      },
    );
    scope.post('/input-bundles/:id/render', async (request, reply) => {
      const { id } = request.params as { id: string };
      const { path } = z.object({ path: inputPathSchema }).strict().parse(request.body);
      // Authorize before capability errors so probing cannot reveal another owner's inputs.
      store.get(id, request.user.oid);
      if (!previews)
        throw new AutopodError(
          'An isolated reference renderer is not configured',
          'REFERENCE_RENDER_UNAVAILABLE',
          503,
        );
      const preview = await previews.render(id, request.user.oid, path);
      reply.header('Cache-Control', 'private, no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
      return { receipt: preview.receipt, base64: preview.bytes.toString('base64') };
    });
    scope.post('/input-bundles/:id/seal', async (request) => {
      const { id } = request.params as { id: string };
      return store.seal(id, request.user.oid);
    });
    scope.get('/input-bundles/:id/files/:index', async (request, reply) => {
      const { id, index } = request.params as { id: string; index: string };
      if (!/^\d{1,2}$/.test(index))
        throw new AutopodError('Invalid input index', 'INVALID_INPUT_UPLOAD', 400);
      const bundle = store.get(id, request.user.oid);
      if (bundle.status !== 'sealed')
        throw new AutopodError('Input upload is incomplete', 'INPUT_UPLOAD_INCOMPLETE', 409);
      const bytes = store.read(id, request.user.oid, Number(index));
      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', 'attachment; filename="reference"')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "sandbox; default-src 'none'")
        .header('Cache-Control', 'private, no-store')
        .send(bytes);
    });
    const timer = setInterval(() => {
      try {
        store.sweep();
      } catch (error) {
        scope.log.error({ err: error }, 'Reference attachment cleanup failed');
      }
    }, 3600_000);
    timer.unref();
    scope.addHook('onClose', async () => clearInterval(timer));
  });
}
