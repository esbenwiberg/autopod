import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';

export function requiresCheckedDelivery(pod: Pick<Pod, 'options'>): boolean {
  return pod.options.output === 'pr' || pod.options.output === 'branch';
}

export const checkedDeliveryRequiredMessage =
  'Branch and PR delivery require passing checks tied to the exact source. Run fresh checks. For eligible PR tasks, Create draft PR from saved work is review-only and does not require a pass.';

export function assertValidationBypassAllowed(pod: Pick<Pod, 'options'>): void {
  if (requiresCheckedDelivery(pod)) {
    throw new AutopodError(checkedDeliveryRequiredMessage, 'CHECKED_DELIVERY_REQUIRED', 409);
  }
}
