/* Reference stage renderer: intentionally independent of jsonl-animate's changing internals. */
(() => {
  const STAGES = [
    ['waiting', 'Waiting', '◷'],
    ['provisioning', 'Arriving', '◇'],
    ['working', 'Working', '⚒'],
    ['validating', 'Checks', '✓'],
    ['review', 'Review', '▤'],
    ['attention', 'Needs you', '?'],
    ['releasing', 'Release', '⚑'],
    ['complete', 'Complete', '★'],
    ['failed', 'Failed', '!'],
    ['stopping', 'Stopping', '◻'],
    ['stopped', 'Stopped', '◻'],
    ['unknown', 'Unknown', '·'],
  ];
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  window.AutoPodVillageRenderer = Object.freeze({
    schemaVersion: 1,
    id: 'autopod-stage-view',
    create({ root, onSelect }) {
      return {
        render(snapshot) {
          const focusedId = document.activeElement?.dataset?.actorId;
          root.classList.toggle('reduced-motion', snapshot.reducedMotion);
          const board = element('div', 'board');
          for (const [stage, title, glyph] of STAGES) {
            const actors = snapshot.actors.filter(
              (actor) =>
                (STAGES.some(([key]) => key === actor.stage) ? actor.stage : 'unknown') === stage,
            );
            if (!actors.length) continue;
            const lane = element('section', `lane stage-${stage}`);
            lane.append(element('h2', 'lane-title', `${title} · ${actors.length}`));
            const cards = element('div', 'cards');
            for (const actor of actors) {
              const card = element('button', 'actor');
              card.type = 'button';
              card.dataset.actorId = actor.id;
              card.setAttribute(
                'aria-label',
                `${actor.title}, ${actor.status.replaceAll('_', ' ')}, open pod details`,
              );
              card.setAttribute('aria-pressed', String(actor.id === snapshot.selectedActorId));
              const fresh =
                snapshot.connected &&
                (actor.source === 'managed'
                  ? snapshot.managedDataFresh
                  : snapshot.activityStreamConnected);
              card.classList.toggle('stale', !fresh);
              card.classList.toggle('managed', actor.source === 'managed');
              card.classList.toggle(
                'moving',
                fresh &&
                  !actor.interactive &&
                  ['provisioning', 'working', 'validating', 'releasing'].includes(stage),
              );
              const character = element('span', 'character', glyph);
              character.setAttribute('aria-hidden', 'true');
              const text = element('span', 'actor-text');
              text.append(element('strong', 'actor-title', actor.title));
              text.append(
                element(
                  'span',
                  'meta',
                  `${actor.source === 'managed' ? 'Managed' : 'Pod'} · ${actor.profile}`,
                ),
              );
              text.append(element('span', 'status', actor.status.replaceAll('_', ' ')));
              if (actor.activity)
                text.append(
                  element(
                    'span',
                    'activity',
                    `${fresh && actor.activity.isRecent ? 'Recent' : 'Earlier'}: ${actor.activity.label}`,
                  ),
                );
              if (actor.interactive)
                text.append(element('span', 'activity', 'Interactive workspace'));
              if (!fresh) text.append(element('span', 'activity', 'Last known state'));
              card.append(character, text);
              card.addEventListener('click', () => onSelect(actor.id));
              cards.append(card);
            }
            lane.append(cards);
            board.append(lane);
          }
          if (!snapshot.actors.length) {
            board.append(element('p', 'empty', 'No pods match this view.'));
          }
          root.replaceChildren(board);
          if (focusedId) {
            [...root.querySelectorAll('button')]
              .find((node) => node.dataset.actorId === focusedId)
              ?.focus({ preventScroll: true });
          }
        },
        dispose() {
          root.replaceChildren();
        },
      };
    },
  });
})();
