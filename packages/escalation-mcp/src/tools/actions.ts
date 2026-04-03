import { generateId } from '@autopod/shared';
import type { ActionDefinition, EscalationRequest } from '@autopod/shared';
import type { PendingRequests } from '../pending-requests.js';
import type { SessionBridge } from '../session-bridge.js';

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
  sessionId: string,
  actionName: string,
  params: Record<string, unknown>,
  bridge: SessionBridge,
  pendingRequests: PendingRequests,
): Promise<string> {
  // Check if this action requires human approval before execution
  if (bridge.actionRequiresApproval(sessionId, actionName)) {
    const approvalResult = await requestApproval(
      sessionId,
      actionName,
      params,
      bridge,
      pendingRequests,
    );
    if (!approvalResult.approved) {
      return approvalResult.message;
    }

    // Approved — execute with skipApprovalCheck to bypass engine's defense-in-depth guard
    const response = await bridge.executeAction(sessionId, actionName, params, {
      skipApprovalCheck: true,
    });
    return formatResponse(response);
  }

  // No approval required — execute directly
  const response = await bridge.executeAction(sessionId, actionName, params);
  return formatResponse(response);
}

async function requestApproval(
  sessionId: string,
  actionName: string,
  params: Record<string, unknown>,
  bridge: SessionBridge,
  pendingRequests: PendingRequests,
): Promise<{ approved: boolean; message: string }> {
  const escalationId = generateId();
  const timeoutMs = bridge.getHumanResponseTimeout(sessionId) * 1000;

  const paramSummary = Object.entries(params)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const escalation: EscalationRequest = {
    id: escalationId,
    sessionId,
    type: 'action_approval',
    timestamp: new Date().toISOString(),
    payload: {
      actionName,
      params,
      description: `Execute action '${actionName}' with parameters:\n${paramSummary}`,
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

function formatResponse(
  response: { success: boolean; data?: unknown; error?: string; quarantined: boolean },
): string {
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
