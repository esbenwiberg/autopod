import type { FastifyInstance } from 'fastify';
import { listBuiltinSkills } from '../../pods/skill-resolver.js';

export function skillRoutes(app: FastifyInstance): void {
  app.get('/api/skills', async () => {
    const skills = await listBuiltinSkills();
    return { skills };
  });
}
