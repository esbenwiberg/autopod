// AutoPod semantics live here; upstream owns artwork, routes and character poses.
export function presentation(actor, snapshot, now = Date.now()) {
  const fresh =
    snapshot.connected &&
    (actor.source === 'managed' ? snapshot.managedDataFresh : snapshot.activityStreamConnected);
  const recent =
    fresh &&
    actor.source === 'native' &&
    !actor.interactive &&
    actor.stage === 'working' &&
    actor.activity?.isRecent &&
    now >= actor.activity.observedAt &&
    now - actor.activity.observedAt <= 30_000;
  const activity = recent ? actor.activity.kind : null;
  const stations = {
    waiting: 'courtyard',
    provisioning: 'guild',
    working: 'square',
    validating: 'checks',
    review: 'review',
    attention: 'noticeboard',
    releasing: 'harbor',
    complete: 'camp',
    failed: 'noticeboard',
    stopping: 'depot',
    stopped: 'camp',
    unknown: 'square',
  };
  const activityStations = {
    read: 'archive',
    search: 'archive',
    edit: 'workshop',
    command: 'workshop',
    check: 'checks',
    review: 'review',
    plan: 'guild',
  };
  return {
    fresh,
    activity,
    station: activityStations[activity] ?? stations[actor.stage] ?? 'square',
    motion: fresh && !snapshot.reducedMotion && !actor.interactive,
    // The live overview has no replay follow-camera zoom. Keep actors legible
    // across the full map, with managed workers still visibly smaller.
    scale: actor.source === 'managed' ? 2.1 : 3.2,
    label: !fresh
      ? 'Last known state'
      : actor.interactive
        ? 'Interactive workspace'
        : recent
          ? `Recent: ${actor.activity.label}`
          : actor.status.replaceAll('_', ' '),
  };
}

export function pointOnRoute(path, distance) {
  let remaining = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining < length) {
      const t = length ? remaining / length : 1;
      return {
        position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        moving: true,
        direction:
          Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])
            ? b[0] > a[0]
              ? 2
              : 1
            : b[1] > a[1]
              ? 0
              : 3,
      };
    }
    remaining -= length;
  }
  return { position: path.at(-1), moving: false, direction: 0 };
}

export function skinFor(id, roster) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return roster[hash % roster.length];
}
