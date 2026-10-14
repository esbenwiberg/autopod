import { ROSTER } from '@jsonl-village/cast.mjs';
import { drawPerformance, performanceAt } from '@jsonl-village/performance.mjs';
import { drawCharacter } from '@jsonl-village/render.mjs';
import meta from '@jsonl-village/sprites.json';
import { STATION_NAMES, stationRoute, stationSeat } from '@jsonl-village/world.mjs';
import { pointOnRoute, presentation, skinFor } from './live-scene.mjs';

const baseURL = new URL('renderer/upstream/public/', document.baseURI);
const assetURL = (path) => new URL(path.replace(/^\//, ''), baseURL).href;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Village asset could not load'));
    image.src = url;
  });

window.AutoPodVillageRenderer = Object.freeze({
  schemaVersion: 1,
  id: 'jsonl-animate-autopod',
  async create({ root, onSelect }) {
    const paths = [
      ...new Set(
        Object.values(meta.characters).flatMap((character) =>
          Object.values(character.animations).map((animation) => animation.image),
        ),
      ),
    ];
    const [images, map] = await Promise.all([
      Promise.all(paths.map(async (path) => [path, await loadImage(assetURL(path))])),
      loadImage(assetURL('assets/village-v4.png')),
    ]);
    const font = new FontFace(
      'Pixelify Sans',
      `url("${assetURL('assets/fonts/PixelifySans.ttf')}")`,
    );
    await font.load();
    document.fonts.add(font);
    const assets = { meta, images: Object.fromEntries(images) };
    const layout = element('div', 'village-layout');
    const world = element('section', 'world');
    const canvas = element('canvas', 'village-canvas');
    canvas.width = canvas.height = 768;
    canvas.setAttribute('aria-label', 'Pod village. Select a pod using the list beside the map.');
    const caption = element('p', 'caption', 'Select a character or pod to open its details.');
    world.append(canvas, caption);
    const list = element('div', 'pod-list');
    list.setAttribute('aria-label', 'Pods in the village');
    layout.append(world, list);
    root.replaceChildren(layout);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    let snapshot;
    let frame;
    let disposed = false;
    let states = new Map();
    let hits = [];
    let lastFrame = 0;

    function updateStates(now) {
      const seconds = performance.now() / 1000;
      const groups = new Map();
      const ordered = [...snapshot.actors].sort((a, b) => a.id.localeCompare(b.id));
      for (const actor of ordered) {
        const view = presentation(actor, snapshot, now);
        if (!groups.has(view.station)) groups.set(view.station, []);
        groups.get(view.station).push({ actor, view });
      }
      const next = new Map();
      for (const [station, actors] of groups)
        actors.forEach(({ actor, view }, index) => {
          const seat = stationSeat(station, index, actors.length);
          const old = states.get(actor.id);
          let state = old ?? { start: seconds, path: [seat], station, seat };
          if (old && (old.station !== station || String(old.seat) !== String(seat))) {
            // A new observation replaces a route; it never queues behind old activity.
            const current = pointOnRoute(old.path, (seconds - old.start) * 0.17).position;
            const route = old.station === station ? [] : stationRoute(old.station, station);
            state = { start: seconds, path: [current, ...route, seat], station, seat };
          }
          if (
            !view.motion ||
            ['attention', 'failed', 'complete', 'stopped', 'stopping'].includes(actor.stage)
          ) {
            state = { ...state, path: [seat] };
          }
          next.set(actor.id, { ...state, actor, view });
        });
      states = next;
    }

    function draw() {
      if (disposed || !snapshot) return;
      updateStates(Date.now()); // Expire tool activity even between native snapshots.
      const seconds = performance.now() / 1000;
      ctx.clearRect(0, 0, 768, 768);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(map, 0, 0, 768, 768);
      hits = [];
      const positioned = [...states.values()].map((state) => ({
        ...state,
        ...pointOnRoute(state.path, (seconds - state.start) * 0.17),
      }));
      for (const state of positioned.sort((a, b) => a.position[1] - b.position[1])) {
        const { actor, view, position } = state;
        const time = view.motion ? seconds : 0;
        const upstreamActor = {
          id: actor.id,
          skin: skinFor(actor.id, ROSTER),
          role: 'helper',
          position,
          moving: state.moving && view.motion,
          direction: state.direction,
          presence: view.activity
            ? { kind: 'running', activity: view.activity }
            : actor.stage === 'attention' && view.fresh
              ? { kind: 'input' }
              : null,
          resting: ['waiting', 'complete', 'stopped'].includes(actor.stage),
          leisure: 'sit',
          restStartedAt: 0,
        };
        // Managed pods remain simple; only native recent tool evidence gets work props.
        const acting =
          actor.source === 'managed' || !view.fresh || actor.interactive
            ? {
                mode: 'idle',
                animation: upstreamActor.moving ? 'walk' : 'idle',
                clock: time,
                nudge: 0,
                hop: 0,
                direction: null,
              }
            : performanceAt(upstreamActor, time, { motion: view.motion });
        const x = position[0] * 768;
        const y = position[1] * 768;
        const actorScale = view.scale / 1.9;
        ctx.save();
        // Scale the whole actor around its feet so props, badges and poses stay
        // aligned with the sprite without changing upstream drawing code.
        ctx.translate(x, y);
        ctx.scale(actorScale, actorScale);
        ctx.translate(-x, -y);
        if (!view.fresh) ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#14232066';
        ctx.beginPath();
        ctx.ellipse(x, y + 3, 14, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        if (actor.id === snapshot.selectedActorId) {
          ctx.strokeStyle = '#fff0ac';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.ellipse(x, y + 2, 24, 10, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        drawPerformance(ctx, upstreamActor, acting, time, { layer: 'back', motion: view.motion });
        drawCharacter(
          ctx,
          { ...upstreamActor, animation: acting.animation, animationTime: acting.clock },
          assets,
          x + acting.nudge,
          y - acting.hop,
          time,
          1.9,
          acting.direction,
        );
        drawPerformance(ctx, upstreamActor, acting, time, { motion: view.motion });
        const badge = {
          attention: '?',
          failed: '!',
          complete: '✓',
          review: 'R',
          validating: '…',
          unknown: '?',
        }[actor.stage];
        if (badge) {
          ctx.fillStyle = actor.stage === 'failed' ? '#983f43' : '#253d49';
          ctx.fillRect(x + 15, y - 48, 20, 21);
          ctx.fillStyle = '#fff3cd';
          ctx.font = '18px "Pixelify Sans", monospace';
          ctx.fillText(badge, x + 20, y - 31);
        }
        ctx.restore();
        hits.push({ id: actor.id, x, y, radius: 32 * actorScale, top: 54 * actorScale, bottom: 12 * actorScale });
        if (actor.id === snapshot.selectedActorId) {
          const title = actor.title.length > 32 ? `${actor.title.slice(0, 31)}…` : actor.title;
          ctx.font = '17px "Pixelify Sans", monospace';
          const width = ctx.measureText(title).width + 16;
          const left = Math.max(4, Math.min(764 - width, x - width / 2));
          ctx.fillStyle = '#152530ee';
          ctx.fillRect(left, y + 14 * actorScale, width, 25);
          ctx.fillStyle = '#fff3cd';
          ctx.fillText(title, left + 8, y + 14 * actorScale + 18);
        }
      }
      canvas.dataset.renderedActors = String(hits.length);
    }

    function tick(timestamp) {
      if (disposed) return;
      if (timestamp - lastFrame >= 1000 / 30) {
        draw();
        lastFrame = timestamp;
      }
      frame = requestAnimationFrame(tick);
    }
    function clicked(event) {
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) * 768) / rect.width;
      const y = ((event.clientY - rect.top) * 768) / rect.height;
      const hit = [...hits]
        .reverse()
        .find((item) => Math.abs(x - item.x) < item.radius && y > item.y - item.top && y < item.y + item.bottom);
      if (hit) onSelect(hit.id);
    }
    canvas.addEventListener('click', clicked);
    return {
      render(next) {
        snapshot = next;
        updateStates(Date.now());
        const focused = document.activeElement?.dataset.actorId;
        const buttons = next.actors.map((actor) => {
          const view = presentation(actor, next);
          const button = element('button', 'actor');
          button.type = 'button';
          button.dataset.actorId = actor.id;
          button.classList.toggle('managed', actor.source === 'managed');
          button.classList.toggle('stale', !view.fresh);
          button.setAttribute('aria-pressed', String(actor.id === next.selectedActorId));
          button.append(
            element('strong', 'actor-title', actor.title),
            element(
              'span',
              'meta',
              `${actor.source === 'managed' ? 'Managed' : 'Native'} · ${actor.status.replaceAll('_', ' ')}`,
            ),
            element('span', 'activity', `${view.label} · ${STATION_NAMES[view.station]}`),
          );
          button.addEventListener('click', () => onSelect(actor.id));
          return button;
        });
        list.replaceChildren(...buttons);
        if (!buttons.length) list.append(element('p', 'empty', 'No pods match this view.'));
        buttons
          .find((button) => button.dataset.actorId === focused)
          ?.focus({ preventScroll: true });
        caption.textContent = next.connected
          ? 'Select a character or pod to open its details.'
          : 'Disconnected · showing last known pod states.';
        draw();
        cancelAnimationFrame(frame);
        if (next.actors.some((actor) => presentation(actor, next).motion))
          frame = requestAnimationFrame(tick);
      },
      dispose() {
        disposed = true;
        cancelAnimationFrame(frame);
        canvas.removeEventListener('click', clicked);
        document.fonts.delete(font);
        states.clear();
        hits = [];
        root.replaceChildren();
      },
    };
  },
});
