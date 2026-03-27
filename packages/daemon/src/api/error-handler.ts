import { AutopodError } from '@autopod/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof AutopodError) {
    reply.status(error.statusCode).send({
      error: error.code,
      message: error.message,
    });
    return;
  }

  // Zod schema validation errors (from manual schema.parse() calls)
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return;
  }

  // Fastify validation errors
  if (error.validation) {
    reply.status(400).send({
      error: 'VALIDATION_ERROR',
      message: error.message,
    });
    return;
  }

  // Never leak stack traces
  request.log.error(error, 'Unhandled error');
  reply.status(500).send({
    error: 'INTERNAL_ERROR',
    message: 'An internal error occurred',
  });
}
