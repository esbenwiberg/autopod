/* Stable host bridge. Replace renderer/, not this file, when updating the artwork. */
(() => {
  const VERSION = 1;
  let renderer;
  let snapshot;
  let disposed = false;
  const post = (message) => window.webkit?.messageHandlers?.village?.postMessage(message);
  const reportFailure = () => post({ type: 'error', schemaVersion: VERSION });

  function validate(value) {
    if (
      value?.schemaVersion !== VERSION ||
      !Array.isArray(value.actors) ||
      typeof value.connected !== 'boolean' ||
      typeof value.activityStreamConnected !== 'boolean' ||
      typeof value.managedDataFresh !== 'boolean' ||
      typeof value.reducedMotion !== 'boolean'
    ) {
      throw new Error('Unsupported village snapshot');
    }
    const ids = new Set();
    for (const actor of value.actors) {
      if (
        !['native', 'managed'].includes(actor.source) ||
        typeof actor.podId !== 'string' ||
        !actor.podId ||
        actor.id !== `${actor.source}:${actor.podId}` ||
        ids.has(actor.id) ||
        !['activity', 'lifecycle'].includes(actor.detailLevel) ||
        typeof actor.title !== 'string' ||
        typeof actor.status !== 'string' ||
        typeof actor.stage !== 'string'
      )
        throw new Error('Invalid village actor');
      ids.add(actor.id);
    }
  }

  function select(actorId) {
    if (!disposed && snapshot?.actors.some((actor) => actor.id === actorId)) {
      post({ type: 'select', schemaVersion: VERSION, actorId });
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer?.dispose();
    renderer = undefined;
    snapshot = undefined;
  }

  window.AutoPodVillageHost = Object.freeze({
    receive(value) {
      if (disposed || !renderer) throw new Error('Village renderer is not ready');
      validate(value);
      // Independent frozen values keep the renderer from changing host identity/state.
      const next = JSON.parse(JSON.stringify(value));
      for (const actor of next.actors) {
        if (actor.activity) Object.freeze(actor.activity);
        Object.freeze(actor);
      }
      Object.freeze(next.actors);
      Object.freeze(next);
      renderer.render(next);
      snapshot = next;
      return true;
    },
    dispose,
  });

  window.addEventListener('pagehide', dispose, { once: true });
  Promise.resolve()
    .then(async () => {
      const plugin = window.AutoPodVillageRenderer;
      if (plugin?.schemaVersion !== VERSION || typeof plugin.create !== 'function') {
        throw new Error('Unsupported village renderer');
      }
      const instance = await plugin.create({
        root: document.getElementById('village'),
        onSelect: select,
      });
      if (typeof instance?.render !== 'function' || typeof instance?.dispose !== 'function') {
        throw new Error('Invalid village renderer interface');
      }
      if (disposed) {
        instance.dispose();
        return;
      }
      renderer = instance;
      post({ type: 'ready', schemaVersion: VERSION });
    })
    .catch(reportFailure);
})();
