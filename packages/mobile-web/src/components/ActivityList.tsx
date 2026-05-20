import type { AgentEvent } from '@autopod/shared';
import { formatActivity, shortTime } from '../lib/activity-format.js';

interface Props {
  events: AgentEvent[];
}

export function ActivityList({ events }: Props): JSX.Element {
  if (events.length === 0) {
    return <p className="muted">No activity yet.</p>;
  }
  return (
    <ul className="activity-list">
      {events.map((event, i) => {
        const f = formatActivity(event, i);
        return (
          <li key={f.key} className={`activity-row activity-${f.tone}`}>
            <span className="activity-glyph" aria-hidden="true">
              {f.glyph}
            </span>
            <span className="activity-text">{f.text}</span>
            <span className="activity-time">{shortTime(f.timestamp)}</span>
          </li>
        );
      })}
    </ul>
  );
}
