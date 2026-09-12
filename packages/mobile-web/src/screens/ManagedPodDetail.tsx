import type { JSX, ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useManagedPodsStore } from '../store/managed-pods.js';
import { ManagedStateChip, formatBytes, formatDate, useManagedPodPolling } from './ManagedPods.js';

export function ManagedPodDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const pod = useManagedPodsStore((state) => state.pods.find((item) => item.podId === id));
  const loading = useManagedPodsStore((state) => state.loading);
  const loaded = useManagedPodsStore((state) => state.loaded);
  const error = useManagedPodsStore((state) => state.error);
  const refresh = useManagedPodsStore((state) => state.refresh);

  useManagedPodPolling(refresh);

  if (error && !pod) {
    return (
      <main>
        <BackLink />
        <div className="error" role="alert">
          {error}
        </div>
      </main>
    );
  }

  if (!pod) {
    return (
      <main>
        <BackLink />
        <p className="empty">
          {loading || !loaded ? 'Loading managed pod…' : 'Managed pod not found.'}
        </p>
      </main>
    );
  }

  return (
    <main>
      <BackLink />
      <header className="detail-header">
        <div className="managed-detail-id">{pod.podId}</div>
        <ManagedStateChip state={pod.state} />
      </header>
      <p className="muted detail-meta">Last event {formatDate(pod.lastEventAt)}</p>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      <ManagedSection title="Identity">
        <ManagedDetailRow label="Dispatcher attempt" value={pod.dispatcherAttemptId} code />
        <ManagedDetailRow label="Profile" value={`${pod.profileId} v${pod.profileVersion}`} />
        <ManagedDetailRow label="Created" value={formatDate(pod.createdAt)} />
      </ManagedSection>

      <ManagedSection title="Route">
        <ManagedDetailRow label="Provider account" value={pod.providerAccountId} />
        <ManagedDetailRow label="Model" value={pod.model} />
        <ManagedDetailRow label="Runtime" value={pod.runtime} />
        <ManagedDetailRow label="Target" value={pod.executionTarget} />
        <ManagedDetailRow label="Reasoning" value={pod.reasoning} />
      </ManagedSection>

      <ManagedSection title="Runtime evidence">
        <ManagedDetailRow label="Provider requests" value={pod.providerRequests.toLocaleString()} />
        <ManagedDetailRow
          label="Observed tokens"
          value={`${pod.consumedTokens.toLocaleString()}${pod.tokenUsageKnown ? '' : ' (incomplete)'}`}
        />
        <ManagedDetailRow label="Observed exit" value={pod.observedExit ? 'Yes' : 'No'} />
        <ManagedDetailRow label="Exit code" value={pod.exitCode?.toString() ?? '—'} />
        <ManagedDetailRow label="Cleanup" value={pod.cleanup} />
        <ManagedDetailRow label="Revoked" value={pod.revoked ? 'Yes' : 'No'} />
        <ManagedDetailRow label="Stop requested" value={pod.stopRequested ? 'Yes' : 'No'} />
      </ManagedSection>

      {pod.failure ? (
        <ManagedSection title="Latest provider failure" tone="danger">
          <ManagedDetailRow label="Phase" value={pod.failure.phase} />
          <ManagedDetailRow label="Reason" value={pod.failure.reason} />
          <ManagedDetailRow label="HTTP status" value={pod.failure.httpStatus?.toString() ?? '—'} />
        </ManagedSection>
      ) : null}

      {pod.limitations.length ? (
        <ManagedSection title="Limitations" tone="warn">
          <ul className="managed-list">
            {pod.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </ManagedSection>
      ) : null}

      <ManagedSection title="Artifacts">
        {pod.artifacts.length ? (
          <div className="managed-artifacts">
            {pod.artifacts.map((artifact) => (
              <div className="managed-artifact" key={artifact.artifactId}>
                <code>{artifact.artifactId}</code>
                <span>
                  {artifact.status} · {artifact.fileCount} files ·{' '}
                  {formatBytes(artifact.totalBytes)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted managed-empty-copy">No committed or pending artifacts.</p>
        )}
      </ManagedSection>
    </main>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link to="/managed-pods" className="back-link">
      ← Managed Pods
    </Link>
  );
}

function ManagedSection({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: 'danger' | 'warn';
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`managed-section${tone ? ` managed-section-${tone}` : ''}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ManagedDetailRow({
  label,
  value,
  code = false,
}: {
  label: string;
  value: string;
  code?: boolean;
}): JSX.Element {
  return (
    <div className="managed-detail-row">
      <span className="managed-detail-label">{label}</span>
      <span className={code ? 'managed-detail-value managed-code' : 'managed-detail-value'}>
        {value}
      </span>
    </div>
  );
}
