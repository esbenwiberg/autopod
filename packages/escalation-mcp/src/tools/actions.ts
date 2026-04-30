import { generateId } from '@autopod/shared';
import type { ActionDefinition, EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { PodBridge } from '../pod-bridge.js';

const APPROVAL_KEYWORDS = ['approved', 'approve', 'yes', 'proceed', 'go ahead', 'confirmed'];

function isApproved(response: string): boolean {
  const lower = response.toLowerCase().trim();
  return APPROVAL_KEYWORDS.some((kw) => lower === kw || lower.startsWith(`${kw}`));
}

/**
 * Execute an action tool call from the agent.
 * If the action requires human approval, creates an escalation and blocks
 * until the human approves or rejects — then executes or returns error.
 */
export async function executeAction(
  podId: string,
  actionName: string,
  params: Record<string, unknown>,
  bridge: PodBridge,
  pendingRequests: PendingRequests,
): Promise<string> {
  // Check if this action requires human approval before execution
  if (bridge.actionRequiresApproval(podId, actionName)) {
    // Gather handler-specific approval context (e.g. deploy script content + hash)
    // BEFORE creating the escalation so the human reviewer sees it.
    let approvalContext: Record<string, unknown> | undefined;
    try {
      approvalContext = await bridge.getActionApprovalContext?.(podId, actionName, params);
    } catch (err) {
      return `Cannot prepare approval context: ${err instanceof Error ? err.message : String(err)}`;
    }

    const approvalResult = await requestApproval(
      podId,
      actionName,
      params,
      bridge,
      pendingRequests,
      approvalContext,
    );
    if (!approvalResult.approved) {
      return approvalResult.message;
    }

    // Approved — execute with skipApprovalCheck to bypass engine's defense-in-depth guard
    const response = await bridge.executeAction(podId, actionName, params, {
      skipApprovalCheck: true,
      approvalContext,
    });
    return formatResponse(response);
  }

  // No approval required — execute directly
  const response = await bridge.executeAction(podId, actionName, params);
  return formatResponse(response);
}

async function requestApproval(
  podId: string,
  actionName: string,
  params: Record<string, unknown>,
  bridge: PodBridge,
  pendingRequests: PendingRequests,
  approvalContext?: Record<string, unknown>,
): Promise<{ approved: boolean; message: string }> {
  const escalationId = generateId();
  const timeoutMs = bridge.getHumanResponseTimeout(podId) * 1000;

  const paramSummary = Object.entries(params)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  // For deploy actions, include the script content so the reviewer knows what they're approving
  let contextSection = '';
  if (approvalContext?.scriptContent) {
    let baselineNote = '';
    if (approvalContext.matchesBaseline === false) {
      baselineNote =
        '\n\n⚠️ This script differs from the trusted baseline captured at pod provision. ' +
        'The deploy handler will refuse to execute it — approving here cannot bypass that check.';
    } else if (approvalContext.matchesBaseline === true) {
      baselineNote = '\n\n✓ Matches the trusted baseline from the base branch.';
    }
    contextSection = `\n\nScript content to be executed:\n\`\`\`\n${approvalContext.scriptContent}\n\`\`\`${baselineNote}`;
  }

  const escalation: EscalationRequest = {
    id: escalationId,
    podId,
    type: 'action_approval',
    timestamp: new Date().toISOString(),
    payload: {
      actionName,
      params,
      approvalContext,
      description: `Execute action '${actionName}' with parameters:\n${paramSummary}${contextSection}`,
    },
    response: null,
  };

  bridge.createEscalation(escalation);

  try {
    const response = await pendingRequests.waitForResponse(escalationId, timeoutMs);

    if (isApproved(response)) {
      return { approved: true, message: '' };
    }

    return {
      approved: false,
      message: `Action '${actionName}' was rejected by human reviewer: ${response}`,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message.includes('timed out');
    return {
      approved: false,
      message: isTimeout
        ? `Action '${actionName}' was not approved within the timeout period. The action was NOT executed.`
        : `Action approval cancelled: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function formatResponse(response: {
  success: boolean;
  data?: unknown;
  error?: string;
  quarantined: boolean;
}): string {
  if (!response.success) {
    return `Action failed: ${response.error}`;
  }

  let text = JSON.stringify(response.data, null, 2);

  if (response.quarantined) {
    text = `⚠️ Note: Some content was quarantined due to injection detection.\n\n${text}`;
  }

  return text;
}

/**
 * Get the Zod-compatible schema params for an action definition.
 * Used for dynamic MCP tool registration.
 */
export function actionParamsToZodShape(
  action: ActionDefinition,
): Record<string, { type: string; description: string; optional: boolean }> {
  const shape: Record<string, { type: string; description: string; optional: boolean }> = {};
  for (const [name, def] of Object.entries(action.params)) {
    shape[name] = {
      type: def.type,
      description: def.description,
      optional: !def.required,
    };
  }
  return shape;
}
