import type { ExternalDeliveryReceipt, ReadinessFinding, ReadinessReview } from '@autopod/shared';

export function withExternalDeliveryReadiness(
  review: ReadinessReview,
  receipt: ExternalDeliveryReceipt | null,
): ReadinessReview {
  if (!receipt) return review;
  const pending: ReadinessFinding = {
    id: 'external-delivery-reports-pending',
    area: 'pr',
    severity: 'warning',
    title: 'Delivered externally — reports pending',
    detail: `Provider-confirmed merge of exact retained source ${receipt.headSha}. Original sandbox ${receipt.retainedSandboxId} and host worktree are retained for report recovery. Report contents have not been claimed preserved. Retained sandbox storage can continue to incur cost. Receipt ${receipt.id}.`,
    sourceRefs: [
      { kind: 'pr', label: 'Merged pull request', href: receipt.prUrl },
      { kind: 'event', label: 'Delivery observation' },
    ],
  };
  return {
    ...review,
    computedAt: new Date().toISOString(),
    status: review.status === 'ready' ? 'needs_review' : review.status,
    summary: `${review.summary} External delivery is verified; workspace reports remain pending.`,
    areas: review.areas.map((area) =>
      area.area === 'pr'
        ? {
            ...area,
            status: area.status === 'risky' ? 'risky' : 'needs_review',
            summary: 'Merged externally; original resources retained for report recovery.',
            sourceRefs: pending.sourceRefs,
          }
        : area,
    ),
    findings: [...review.findings.filter((finding) => finding.id !== pending.id), pending],
  };
}
