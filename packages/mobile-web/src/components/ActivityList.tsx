import type { AgentEvent } from '@autopod/shared';
import { formatActivity, shortTime } from '../lib/activity-format.js';

interface Props {
  events: AgentEvent[];
  maxCount?: number;
}

export function ActivityList({ events, maxCount = 6 }: Props): JSX.Element {
  const visibleEvents = events.filter(isOverviewActivity).slice(-maxCount);

  if (visibleEvents.length === 0) {
    return <p className="muted">No activity yet.</p>;
  }
  return (
    <ul className="activity-list">
      {visibleEvents.map((event, i) => {
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

export function isOverviewActivity(event: AgentEvent): boolean {
  switch (event.type) {
    case 'status':
    case 'file_change':
    case 'escalation':
    case 'plan':
    case 'progress':
    case 'error':
    case 'complete':
    case 'task_summary':
      return true;
    case 'tool_use':
    case 'reasoning':
      return false;
  }
}
