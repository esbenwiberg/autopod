import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AutopodError } from '@autopod/shared';

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof AutopodError) {
    reply.status(error.statusCode).send({
      error: error.code,
      message: error.message,
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
