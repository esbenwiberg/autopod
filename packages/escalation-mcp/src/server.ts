import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionBridge } from './session-bridge.js';
import { PendingRequests } from './pending-requests.js';
import { askHuman } from './tools/ask-human.js';
import { askAi } from './tools/ask-ai.js';
import { reportBlocker } from './tools/report-blocker.js';

export interface EscalationMcpDeps {
  sessionId: string;
  bridge: SessionBridge;
}

export function createEscalationMcpServer(deps: EscalationMcpDeps): {
  server: McpServer;
  pendingRequests: PendingRequests;
} {
  const { sessionId, bridge } = deps;
  const pendingRequests = new PendingRequests();

  const server = new McpServer({
    name: 'autopod-escalation',
    version: '0.0.1',
  });

  server.tool(
    'ask_human',
    'Ask a human for help, clarification, or a decision. Use when you are uncertain or blocked.',
    {
      question: z.string().describe('The question to ask the human'),
      context: z.string().optional().describe('Additional context to help the human understand'),
      options: z
        .array(z.string())
        .optional()
        .describe('Suggested options for the human to choose from'),
    },
    async (input) => {
      const response = await askHuman(sessionId, input, bridge, pendingRequests);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'ask_ai',
    'Consult another AI model for a second opinion or domain expertise. Rate-limited.',
    {
      question: z.string().describe('The question to ask the AI reviewer'),
      context: z.string().optional().describe('Relevant code or context'),
      domain: z.string().optional().describe('Domain area (e.g., "security", "performance")'),
    },
    async (input) => {
      const response = await askAi(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'report_blocker',
    'Report a blocking issue that prevents progress. If too many blockers, the session will pause for human review.',
    {
      description: z.string().describe('Description of the blocking issue'),
      attempted: z.array(z.string()).describe('List of approaches already attempted'),
      needs: z.string().describe('What is needed to unblock'),
    },
    async (input) => {
      const response = await reportBlocker(sessionId, input, bridge, pendingRequests);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  return { server, pendingRequests };
}
