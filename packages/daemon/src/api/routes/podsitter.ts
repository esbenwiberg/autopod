import {
  AutopodError,
  type OperatorActor,
  PROVIDER_CATALOG,
  type PodsitterConfiguration,
  podsitterConfigurationInputSchema,
} from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EventBus } from '../../pods/event-bus.js';
import type { PodsitterRepository } from '../../podsitter/podsitter-repository.js';
import type { PodsitterService } from '../../podsitter/podsitter-service.js';
import type { ProviderAccountStore } from '../../provider-accounts/provider-account-store.js';

export interface PodsitterRouteDependencies {
  repository: PodsitterRepository;
  service: PodsitterService;
  providerAccountStore: ProviderAccountStore;
  eventBus: EventBus;
  hosted?: boolean;
  hostedImage?: string;
}

function requireOperator(request: FastifyRequest): void {
  if (!request.user.roles.some((role) => role === 'admin' || role === 'operator')) {
    throw new AutopodError('Podsitter operator role required', 'FORBIDDEN', 403);
  }
}

function actor(request: FastifyRequest): OperatorActor {
  return {
    type: 'human',
    userId: request.user.oid,
    ...(request.user.name ? { displayName: request.user.name } : {}),
  };
}

function configurationInput(
  current: PodsitterConfiguration,
): Omit<Parameters<PodsitterRepository['replaceConfiguration']>[0], 'updatedBy'> {
  return {
    enabled: current.enabled,
    activation: current.activation,
    authorizedUntil: current.authorizedUntil,
    profileScope: current.profileScope,
    decisionTarget: current.decisionTarget,
    budgets: current.budgets,
  };
}

function assertTarget(
  target: PodsitterConfiguration['decisionTarget'],
  deps: PodsitterRouteDependencies,
): void {
  if (!target)
    throw new AutopodError('A dedicated decision target is required', 'BAD_REQUEST', 400);
  const account = deps.providerAccountStore.get(target.providerAccountId);
  if (!account.credentials) {
    throw new AutopodError(
      'The dedicated provider account is not authenticated',
      'PODSITTER_ACCOUNT_UNAUTHENTICATED',
      400,
    );
  }
  const provider = PROVIDER_CATALOG.providers.find((item) => item.id === account.provider);
  const compatible =
    target.runtime === 'pi' ||
    (target.runtime === 'claude' &&
      ['anthropic', 'bedrock', 'vertex', 'foundry'].includes(account.provider)) ||
    (target.runtime === 'codex' && ['openai', 'foundry'].includes(account.provider)) ||
    (target.runtime === 'copilot' && account.provider === 'copilot');
  if (!provider || !compatible) {
    throw new AutopodError(
      `Runtime "${target.runtime}" is incompatible with dedicated provider "${account.provider}"`,
      'PODSITTER_ACCOUNT_INCOMPATIBLE',
      400,
    );
  }
  if (deps.hosted && !deps.hostedImage) {
    throw new AutopodError(
      'SYSTEM_DECISION_IMAGE is required for hosted Podsitter inference',
      'PODSITTER_IMAGE_REQUIRED',
      400,
    );
  }
}

export function podsitterRoutes(app: FastifyInstance, deps: PodsitterRouteDependencies): void {
  app.get('/podsitter', async () => deps.service.status());

  app.put('/podsitter/config', async (request) => {
    requireOperator(request);
    const body = request.body as Record<string, unknown>;
    const parsed = podsitterConfigurationInputSchema.omit({ updatedBy: true }).parse(body) as Omit<
      Parameters<PodsitterRepository['replaceConfiguration']>[0],
      'updatedBy'
    >;
    if (parsed.enabled || parsed.decisionTarget) assertTarget(parsed.decisionTarget, deps);
    const configuration = deps.repository.replaceConfiguration({
      ...parsed,
      updatedBy: actor(request),
    });
    deps.eventBus.emit({
      type: 'podsitter.activation_changed',
      timestamp: new Date().toISOString(),
      enabled: configuration.enabled,
      active: configuration.enabled,
      reason: configuration.enabled ? 'enabled' : 'disabled',
      generation: configuration.generation,
      actor: actor(request),
    });
    return configuration;
  });

  app.post('/podsitter/enable', async (request) => {
    requireOperator(request);
    const current = deps.repository.getConfiguration();
    if (!current) throw new AutopodError('Podsitter is not configured', 'NOT_FOUND', 404);
    assertTarget(current.decisionTarget, deps);
    const body = (request.body ?? {}) as { authorizedUntil?: string | null };
    const configuration = deps.repository.replaceConfiguration({
      ...configurationInput(current),
      enabled: true,
      authorizedUntil:
        body.authorizedUntil === undefined ? current.authorizedUntil : body.authorizedUntil,
      updatedBy: actor(request),
    });
    deps.eventBus.emit({
      type: 'podsitter.activation_changed',
      timestamp: new Date().toISOString(),
      enabled: true,
      active: true,
      reason: 'enabled',
      generation: configuration.generation,
      actor: actor(request),
    });
    void deps.service.reconcile();
    return configuration;
  });

  app.post('/podsitter/disable', async (request) => {
    requireOperator(request);
    const current = deps.repository.getConfiguration();
    if (!current) throw new AutopodError('Podsitter is not configured', 'NOT_FOUND', 404);
    const configuration = deps.repository.replaceConfiguration({
      ...configurationInput(current),
      enabled: false,
      updatedBy: actor(request),
    });
    deps.eventBus.emit({
      type: 'podsitter.activation_changed',
      timestamp: new Date().toISOString(),
      enabled: false,
      active: false,
      reason: 'disabled',
      generation: configuration.generation,
      actor: actor(request),
    });
    return configuration;
  });

  app.post('/podsitter/check', async (request) => {
    requireOperator(request);
    const current = deps.repository.getConfiguration();
    return deps.service.reconcile({ readOnly: !current?.enabled });
  });

  app.post('/podsitter/provider/probe', async (request) => {
    requireOperator(request);
    return { recovered: await deps.service.probe() };
  });

  app.get('/podsitter/decisions', async (request) => {
    const query = request.query as { podId?: string; limit?: string; offset?: string };
    return deps.repository.listDecisions({
      podId: query.podId,
      limit: query.limit ? Number.parseInt(query.limit, 10) : undefined,
      offset: query.offset ? Number.parseInt(query.offset, 10) : undefined,
    });
  });

  app.get('/podsitter/decisions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const decision = deps.repository.getDecisionById(id);
    if (!decision) throw new AutopodError('Podsitter decision not found', 'NOT_FOUND', 404);
    return decision;
  });
}
