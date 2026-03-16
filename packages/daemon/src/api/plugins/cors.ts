import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

export async function corsPlugin(app: FastifyInstance): Promise<void> {
  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  });
}
