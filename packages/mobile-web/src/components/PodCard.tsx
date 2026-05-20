import type { Pod } from '@autopod/shared';
import { Link } from 'react-router-dom';
import { StatusChip } from './StatusChip.js';

interface Props {
  pod: Pod;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function PodCard({ pod }: Props): JSX.Element {
  return (
    <Link to={`/pod/${pod.id}`} className="pod-card">
      <div className="pod-card-row">
        <span className="pod-card-id">{shortId(pod.id)}</span>
        <StatusChip status={pod.status} />
      </div>
      <div className="pod-card-task">{pod.task}</div>
      <div className="pod-card-meta">{pod.profileName}</div>
    </Link>
  );
}
