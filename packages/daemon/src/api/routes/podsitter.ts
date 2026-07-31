import {
  AutopodError,
  type ExecutionTarget,
  type OperatorActor,
  PROVIDER_CATALOG,
  type PodsitterConfiguration,
  podsitterConfigurationInputSchema,
} from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { EventBus } from '../../pods/event-bus.js';
import { evaluatePodsitterActivation } from '../../podsitter/activation.js';
import type { PodsitterRepository } from '../../podsitter/podsitter-repository.js';
import type { PodsitterService } from '../../podsitter/podsitter-service.js';
import type { ProviderAccountStore } from '../../provider-accounts/provider-account-store.js';
import { isProviderAccountRuntimeCompatible } from '../../providers/env-builder.js';
import { isPinnedHostedSystemDecisionImage } from '../../system-sandbox/execution-target.js';

export interface PodsitterRouteDependencies {
  repository: PodsitterRepository;
  service: PodsitterService;
  providerAccountStore: ProviderAccountStore;
  eventBus: EventBus;
  executionTarget?: ExecutionTarget;
  hostedImage?: string;
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
  const compatible = isProviderAccountRuntimeCompatible(account, account.provider, target.runtime);
  if (!provider || !compatible) {
    throw new AutopodError(
      `Runtime "${target.runtime}" is incompatible with dedicated provider "${account.provider}"`,
      'PODSITTER_ACCOUNT_INCOMPATIBLE',
      400,
    );
  }
  if (deps.executionTarget === 'sandbox' && !isPinnedHostedSystemDecisionImage(deps.hostedImage)) {
    throw new AutopodError(
      'AUTOPOD_SYSTEM_DECISION_IMAGE must be an ACR-qualified pinned tag or digest for hosted Podsitter inference',
      'PODSITTER_IMAGE_REQUIRED',
      400,
    );
  }
}

export function podsitterRoutes(app: FastifyInstance, deps: PodsitterRouteDependencies): void {
  app.get('/podsitter', async () => deps.service.status());

  app.put('/podsitter/config', async (request) => {
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
    const activation = evaluatePodsitterActivation(configuration, new Date());
    deps.eventBus.emit({
      type: 'podsitter.activation_changed',
      timestamp: new Date().toISOString(),
      enabled: configuration.enabled,
      active: activation.active,
      reason: activation.reason,
      generation: configuration.generation,
      actor: actor(request),
    });
    return configuration;
  });

  app.post('/podsitter/enable', async (request) => {
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
    const activation = evaluatePodsitterActivation(configuration, new Date());
    deps.eventBus.emit({
      type: 'podsitter.activation_changed',
      timestamp: new Date().toISOString(),
      enabled: true,
      active: activation.active,
      reason: activation.reason,
      generation: configuration.generation,
      actor: actor(request),
    });
    void deps.service.reconcile();
    return configuration;
  });

  app.post('/podsitter/disable', async (request) => {
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
    const current = deps.repository.getConfiguration();
    const active = current ? evaluatePodsitterActivation(current, new Date()).active : false;
    return deps.service.reconcile({ readOnly: !active });
  });

  app.post('/podsitter/provider/probe', async () => {
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
