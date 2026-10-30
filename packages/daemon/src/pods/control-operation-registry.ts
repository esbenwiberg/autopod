/** Runtime quiescence for already-entered facade controls, before their first external await.
 * Durable provider intents and execution ledgers remain independently authoritative across restart.
 */
export function createControlOperationRegistry(
  assertMutationAllowed: (podId: string, operation: string) => void = () => {},
) {
  const active = new Map<string, Set<symbol>>();
  function wrap<T extends object>(target: T): T {
    const cache = new Map<PropertyKey, { original: unknown; wrapped: unknown }>();
    const synchronous = new Set([
      'notifyEscalation',
      'nudgeSession',
      'refreshReadinessAfterQualityScore',
      'interruptValidation',
      'setSkipValidation',
      'createMemoryWorkspace',
      'createHistoryWorkspace',
      'authorizeValidationRecoveryBudget',
    ]);
    return new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver);
        if (
          typeof value !== 'function' ||
          key === 'adoptSource' ||
          key === 'reconcileValidationExecution' ||
          key === 'readValidationEvidence' ||
          key === 'touchHeartbeat' ||
          /^(get|list|inspect|watch|assert)/.test(String(key))
        )
          return value;
        const prior = cache.get(key);
        if (prior?.original === value) return prior.wrapped;
        const wrapped = (...args: unknown[]) => {
          const id = args[0];
          if (typeof id !== 'string') return Reflect.apply(value, receiver, args);
          try {
            assertMutationAllowed(id, String(key));
          } catch (error) {
            if (synchronous.has(String(key))) throw error;
            return Promise.reject(error);
          }
          const token = Symbol(String(key));
          const claims = active.get(id) ?? new Set<symbol>();
          claims.add(token);
          active.set(id, claims);
          const release = () => {
            claims.delete(token);
            if (!claims.size && active.get(id) === claims) active.delete(id);
          };
          try {
            const result: unknown = Reflect.apply(value, receiver, args);
            if (result instanceof Promise) {
              void result.then(release, release);
              return result;
            }
            release();
            return result;
          } catch (error) {
            release();
            throw error;
          }
        };
        cache.set(key, { original: value, wrapped });
        return wrapped;
      },
    });
  }
  return { wrap, isActive: (podId: string) => Boolean(active.get(podId)?.size) };
}
