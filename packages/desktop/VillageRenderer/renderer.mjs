import { actorAtScreen } from '@jsonl-village/camera.mjs';
import { ROSTER } from '@jsonl-village/cast.mjs';
import { VIEW, renderFrame } from '@jsonl-village/render.mjs';
import meta from '@jsonl-village/sprites.json';
import { STATION_NAMES, stationRoute, stationSeat } from '@jsonl-village/world.mjs';
import { presentation } from './live-scene.mjs';
import { createLiveTimeline } from './live-timeline.mjs';

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
    const assets = { meta, images: Object.fromEntries(images), map, innMap: map };
    const layout = element('div', 'village-layout');
    const world = element('section', 'world');
    const canvas = element('canvas', 'village-canvas');
    canvas.width = VIEW.width;
    canvas.height = VIEW.height;
    canvas.setAttribute('aria-label', 'Pod village. Select a pod using the list beside the map.');
    const caption = element('p', 'caption', 'Select a character or pod to open its details.');
    const controls = element('div', 'camera-controls');
    const follow = element('button', 'camera-follow', 'Follow pod');
    const overview = element('button', 'camera-village', 'Whole village');
    const focusPicker = element('select', 'camera-pod');
    focusPicker.setAttribute('aria-label', 'Pod to follow');
    follow.type = overview.type = 'button';
    controls.append(follow, overview, focusPicker);
    world.append(controls, canvas, caption);
    const list = element('div', 'pod-list');
    list.setAttribute('aria-label', 'Pods in the village');
    layout.append(world, list);
    root.replaceChildren(layout);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    let snapshot;
    let frame;
    let disposed = false;
    const live = createLiveTimeline({ roster: ROSTER, stationRoute, stationSeat });
    let renderedState;
    let focus = null;
    let camera = 'follow';
    let lastFrame = 0;

    function draw() {
      if (disposed || !snapshot) return;
      const seconds = performance.now() / 1000;
      const timeline = live.update(snapshot, Date.now(), seconds);
      const motion = snapshot.actors.some((actor) => presentation(actor, snapshot).motion);
      ctx.clearRect(0, 0, VIEW.width, VIEW.height);
      renderedState = renderFrame(ctx, timeline, seconds, assets, {
        focus,
        camera,
        reactions: motion,
      });
      canvas.dataset.renderedActors = String(renderedState.actors.length);
      canvas.dataset.camera = renderedState.camera.mode;
      canvas.dataset.cameraScale = String(renderedState.camera.scale);
      canvas.dataset.focus = focus ?? '';
      follow.setAttribute('aria-pressed', String(camera === 'follow'));
      overview.setAttribute('aria-pressed', String(camera === 'village'));
      follow.disabled = focusPicker.disabled = !snapshot.actors.length;
      caption.textContent = !snapshot.connected
        ? 'Disconnected · showing last known pod states.'
        : !snapshot.actors.length
          ? 'No unfinished pods. New pods appear here automatically.'
          : camera === 'follow'
            ? `Following ${snapshot.actors.find((actor) => actor.id === focus)?.podId ?? 'pod'} · select a character to open its details.`
            : 'Whole village · select a character to open its details.';
    }
    function setCamera(mode) {
      camera = mode;
      draw();
    }
    follow.addEventListener('click', () => setCamera('follow'));
    overview.addEventListener('click', () => setCamera('village'));
    focusPicker.addEventListener('change', () => {
      focus = focusPicker.value;
      setCamera('follow');
    });

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
      const x = ((event.clientX - rect.left) * VIEW.width) / rect.width;
      const y = ((event.clientY - rect.top) * VIEW.height) / rect.height;
      const hit = renderedState && actorAtScreen(renderedState, x, y);
      if (hit) {
        focus = hit.id;
        focusPicker.value = focus;
        draw();
        onSelect(hit.id);
      }
    }
    canvas.addEventListener('click', clicked);
    return {
      render(next) {
        const changedSelection = next.selectedActorId !== snapshot?.selectedActorId;
        snapshot = next;
        if (changedSelection && next.actors.some((actor) => actor.id === next.selectedActorId))
          focus = next.selectedActorId;
        if (!next.actors.some((actor) => actor.id === focus))
          focus =
            next.actors.find((actor) => actor.source === 'native')?.id ??
            next.actors[0]?.id ??
            null;
        focusPicker.replaceChildren(
          ...next.actors.map((actor) => {
            const option = element(
              'option',
              '',
              `${actor.podId} · ${actor.source === 'managed' ? 'Managed' : 'Native'}`,
            );
            option.value = actor.id;
            return option;
          }),
        );
        focusPicker.value = focus ?? '';
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
        live.clear();
        renderedState = null;
        root.replaceChildren();
      },
    };
  },
});
