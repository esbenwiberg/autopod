import type { Pod } from '@autopod/shared';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import {
  planLabel,
  progressLabel,
  taskPreview,
  taskTitle,
  validationLabel,
  validationTone,
} from '../lib/pod-display.js';
import { StatusChip } from './StatusChip.js';

interface Props {
  pod: Pod;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function PodCard({ pod }: Props): JSX.Element {
  const progress = progressLabel(pod);
  const plan = planLabel(pod);
  const validation = validationLabel(pod.lastValidationResult);
  const preview = taskPreview(pod.task);

  return (
    <Link to={`/pod/${pod.id}`} className="pod-card">
      <div className="pod-card-row">
        <span className="pod-card-id">{shortId(pod.id)}</span>
        <StatusChip status={pod.status} />
      </div>
      <div className="pod-card-task">{taskTitle(pod.task)}</div>
      {preview ? <div className="pod-card-preview">{preview}</div> : null}
      <div className="pod-card-signals">
        {progress ? <span>{progress}</span> : null}
        {!progress && plan ? <span>Plan: {plan}</span> : null}
        {validation ? (
          <span className={`signal signal-${validationTone(pod.lastValidationResult)}`}>
            {validation}
          </span>
        ) : null}
      </div>
      <div className="pod-card-meta">{pod.profileName}</div>
    </Link>
  );
}
