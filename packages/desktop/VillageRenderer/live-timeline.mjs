import { pointOnRoute, presentation, skinFor } from './live-scene.mjs';

// Adapt current observations to the upstream renderer's scene contract. This is
// not a replay: no log compilation, invented completion, recap or retirement.
export function createLiveTimeline({ roster, stationRoute, stationSeat }) {
  let states = new Map();
  return {
    clear() {
      states.clear();
    },
    update(snapshot, now, seconds) {
      const groups = new Map();
      for (const actor of [...snapshot.actors].sort((a, b) => a.id.localeCompare(b.id))) {
        const view = presentation(actor, snapshot, now);
        if (!groups.has(view.station)) groups.set(view.station, []);
        groups.get(view.station).push({ actor, view });
      }
      const next = new Map();
      const timeline = {
        assetVersion: 'village-4',
        duration: Number.MAX_SAFE_INTEGER,
        actors: [],
        scenes: [],
        presence: {},
        interludes: {},
      };
      for (const [station, group] of groups)
        group.forEach(({ actor, view }, index) => {
          const seat = stationSeat(station, index, group.length);
          const old = states.get(actor.id);
          let state = old ?? { start: seconds, path: [seat], station, seat };
          if (old && (old.station !== station || String(old.seat) !== String(seat))) {
            const current = pointOnRoute(old.path, (seconds - old.start) * 0.17).position;
            const route = old.station === station ? [] : stationRoute(old.station, station);
            state = { start: seconds, path: [current, ...route, seat], station, seat };
          }
          if (
            !view.motion ||
            ['attention', 'failed', 'complete', 'stopped', 'stopping'].includes(actor.stage)
          )
            state = { ...state, path: [seat] };
          next.set(actor.id, state);
          const travel =
            state.path
              .slice(1)
              .reduce(
                (sum, point, i) =>
                  sum + Math.hypot(point[0] - state.path[i][0], point[1] - state.path[i][1]),
                0,
              ) / 0.17;
          const kind = view.activity
            ? 'action.poll'
            : actor.stage === 'failed'
              ? 'action.result'
              : 'message';
          const id = `observation:${actor.id}`;
          const statusLabel = actor.status.replaceAll('_', ' ');
          const detail = view.label === statusLabel ? '' : ` ${view.label}.`;
          const text = `${actor.source === 'managed' ? 'Managed' : 'Native'} pod ${actor.podId} · ${statusLabel}.${detail}`;
          timeline.actors.push({
            id: actor.id,
            name: actor.podId,
            role: actor.source === 'managed' ? 'helper' : 'lead',
            skin: skinFor(actor.id, roster),
            appearsAt: 0,
            startPosition: seat,
          });
          timeline.scenes.push({
            id,
            start: state.start,
            end: Number.MAX_SAFE_INTEGER,
            travel,
            path: state.path,
            station,
            activity: view.activity ?? 'unknown',
            activityLabel: view.label,
            text,
            status: actor.stage === 'failed' ? 'failed' : 'observed',
            event: {
              actorId: actor.id,
              kind,
              data: {
                status: actor.stage === 'failed' ? 'failed' : 'observed',
                ...(actor.stage === 'attention' ? { waiting: { kind: 'input' } } : {}),
              },
            },
          });
          timeline.presence[actor.id] = [
            {
              at: 0,
              value: {
                kind: actor.stage === 'attention' && view.fresh ? 'input' : 'idle',
                label: view.label,
                targetIds: [],
                sourceId: id,
                basis: 'Latest AutoPod lifecycle observation',
              },
            },
          ];
        });
      timeline.scenes.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      if (!timeline.actors.length)
        timeline.scenes.push({
          id: 'empty',
          start: 0,
          end: Number.MAX_SAFE_INTEGER,
          travel: 0,
          text: snapshot.connected
            ? 'No unfinished pods. New pods appear here automatically.'
            : 'Disconnected. Waiting for pod states.',
          activityLabel: 'Live AutoPod fleet',
          station: 'square',
          event: { actorId: null, kind: 'message', data: {} },
        });
      states = next;
      return timeline;
    },
  };
}
