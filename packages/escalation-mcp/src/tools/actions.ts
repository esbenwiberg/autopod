import type { SessionBridge } from '../session-bridge.js';
import type { ActionDefinition } from '@autopod/shared';

/**
 * Execute an action tool call from the agent.
 * This is the generic handler — each action definition becomes its own MCP tool,
 * but they all route through here.
 */
export async function executeAction(
  sessionId: string,
  actionName: string,
  params: Record<string, unknown>,
  bridge: SessionBridge,
): Promise<string> {
  const response = await bridge.executeAction(sessionId, actionName, params);

  if (!response.success) {
    return `Action failed: ${response.error}`;
  }

  // Format the response data for the agent
  let text = JSON.stringify(response.data, null, 2);

  // Add sanitization notice if content was processed
  if (response.quarantined) {
    text = `⚠️ Note: Some content was quarantined due to injection detection.\n\n${text}`;
  }

  return text;
}

/**
 * Get the Zod-compatible schema params for an action definition.
 * Used for dynamic MCP tool registration.
 */
export function actionParamsToZodShape(action: ActionDefinition): Record<string, { type: string; description: string; optional: boolean }> {
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
