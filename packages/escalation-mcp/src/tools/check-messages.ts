import type { SessionBridge } from '../session-bridge.js';

export async function checkMessages(sessionId: string, bridge: SessionBridge): Promise<string> {
  const result = bridge.consumeMessages(sessionId);
  if (result.hasMessage) {
    return JSON.stringify({ hasMessage: true, message: result.message });
  }
  return JSON.stringify({ hasMessage: false });
}
