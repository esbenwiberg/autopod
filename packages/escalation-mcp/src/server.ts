import type { ActionDefinition } from '@autopod/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PendingRequests } from './pending-requests.js';
import type { SessionBridge } from './session-bridge.js';
import { executeAction } from './tools/actions.js';
import { askAi } from './tools/ask-ai.js';
import { askHuman } from './tools/ask-human.js';
import { checkMessages } from './tools/check-messages.js';
import { memoryList } from './tools/memory-list.js';
import { memoryRead } from './tools/memory-read.js';
import { memorySearch } from './tools/memory-search.js';
import { memorySuggest } from './tools/memory-suggest.js';
import { reportBlocker } from './tools/report-blocker.js';
import { reportPlan } from './tools/report-plan.js';
import { reportProgress } from './tools/report-progress.js';
import { reportTaskSummary } from './tools/report-task-summary.js';
import { requestCredential } from './tools/request-credential.js';
import { validateInBrowser } from './tools/validate-in-browser.js';

export interface EscalationMcpDeps {
  sessionId: string;
  bridge: SessionBridge;
  /** Actions available for this session (pre-resolved from profile) */
  availableActions?: ActionDefinition[];
  /** Reuse an existing PendingRequests instance (e.g. when creating a fresh server per HTTP request) */
  pendingRequests?: PendingRequests;
}

export function createEscalationMcpServer(deps: EscalationMcpDeps): {
  server: McpServer;
  pendingRequests: PendingRequests;
} {
  const { sessionId, bridge, availableActions } = deps;
  const pendingRequests = deps.pendingRequests ?? new PendingRequests();

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

  server.tool(
    'report_plan',
    'Report your implementation plan before writing any code. Fire-and-forget — does not block.',
    {
      summary: z.string().describe('A one-line summary of your approach'),
      steps: z.array(z.string()).describe('Numbered steps you plan to take'),
    },
    async (input) => {
      const response = await reportPlan(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'report_progress',
    'Report a phase transition in your work. Fire-and-forget — does not block.',
    {
      phase: z.string().describe('Name of the current phase (e.g., "Implementation", "Testing")'),
      description: z.string().describe('Brief description of what you are doing in this phase'),
      currentPhase: z.number().int().min(1).describe('Current phase number (1-based)'),
      totalPhases: z.number().int().min(1).describe('Total number of phases'),
    },
    async (input) => {
      const response = await reportProgress(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'report_task_summary',
    'Report what you actually did and any deviations from your original plan. Call this as your final step before finishing. Fire-and-forget — does not block.',
    {
      actualSummary: z.string().describe('A concise description of what was actually accomplished'),
      deviations: z
        .array(
          z.object({
            step: z.string().describe('Which plan step this deviation relates to (e.g. "Step 2")'),
            planned: z.string().describe('What was originally planned for this step'),
            actual: z.string().describe('What was actually done instead'),
            reason: z.string().describe('Why the deviation was necessary'),
          }),
        )
        .describe(
          'Deviations from the original plan. Use an empty array if you followed the plan exactly.',
        ),
    },
    async (input) => {
      const response = await reportTaskSummary(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'request_credential',
    'Request credentials for GitHub or Azure DevOps. Blocks until a human approves — the daemon injects the credential directly into the container, you will never see the token value. Call this when you need to authenticate to push code, create PRs, or access private resources.',
    {
      service: z
        .enum(['github', 'ado'])
        .describe('Which service to authenticate against: "github" or "ado" (Azure DevOps)'),
      reason: z
        .string()
        .describe('Why you need these credentials — shown to the human for approval'),
    },
    async (input) => {
      const response = await requestCredential(sessionId, input, bridge, pendingRequests);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'check_messages',
    'Check if the human has sent you a message. Call between phases. Returns immediately.',
    {},
    async () => {
      const response = await checkMessages(sessionId, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'validate_in_browser',
    'Open a browser in your container to verify your work. URL must be localhost. Use this to check your changes against acceptance criteria before committing.',
    {
      url: z
        .string()
        .describe(
          'The localhost URL to validate (e.g., http://localhost:3000/settings). Must be localhost or 127.0.0.1.',
        ),
      checks: z
        .array(z.string())
        .min(1)
        .describe(
          'Natural language checks to perform (e.g., "Verify there is a dark mode toggle that is visible and clickable")',
        ),
    },
    async (input) => {
      const response = await validateInBrowser(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  // ─── Memory tools ────────────────────────────────────────────────────────────
  server.tool(
    'memory_list',
    'List approved memories for a scope. Use this to check existing knowledge before starting work.',
    {
      scope: z
        .enum(['global', 'profile', 'session'])
        .describe('global = cross-project, profile = this repo, session = this session only'),
    },
    async (input) => {
      const response = await memoryList(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'memory_read',
    'Read the full content of a memory entry by ID.',
    {
      id: z.string().describe('Memory entry ID from memory_list or memory_search'),
    },
    async (input) => {
      const response = await memoryRead(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'memory_search',
    'Search memories by keyword within a scope.',
    {
      query: z.string().describe('Search text to match against path or content'),
      scope: z.enum(['global', 'profile', 'session']).describe('Scope to search within'),
    },
    async (input) => {
      const response = await memorySearch(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  server.tool(
    'memory_suggest',
    'Suggest a new memory for human approval. Use to capture conventions, patterns, or session notes that should persist. A human will review and approve before it becomes active.',
    {
      scope: z
        .enum(['global', 'profile', 'session'])
        .describe('global = applies everywhere, profile = this repo, session = this session only'),
      path: z
        .string()
        .describe(
          'Path-like key for the memory, e.g. "/conventions/commits.md" or "/patterns/error-handling.md"',
        ),
      content: z.string().describe('The memory content (markdown supported)'),
    },
    async (input) => {
      const response = await memorySuggest(sessionId, input, bridge);
      return { content: [{ type: 'text' as const, text: response }] };
    },
  );

  // ─── Revalidation tool (only for workspace pods linked to a failed worker) ───
  const linkedId = bridge.getLinkedSessionId(sessionId);
  if (linkedId) {
    server.tool(
      'trigger_revalidation',
      'Trigger revalidation on the linked failed worker session. Call after you have committed and pushed your fixes. Pulls latest changes and runs validation (build, tests, smoke, AI review). Returns the result.',
      {},
      async () => {
        const result = await bridge.revalidateLinkedSession(linkedId);
        let text: string;
        if (!result.newCommits) {
          text =
            'No new commits found on the branch. Make sure you have committed and pushed your changes before triggering revalidation.';
        } else if (result.result === 'pass') {
          text =
            'Revalidation PASSED! The linked worker session has been transitioned to validated.';
        } else {
          text =
            'Revalidation FAILED. The fixes did not resolve all issues. Check the validation results and try again.';
        }
        return { content: [{ type: 'text' as const, text }] };
      },
    );
  }

  // ─── Dynamic action tools ────────────────────────────────────
  // Register one MCP tool per available action from the profile's action policy
  if (availableActions) {
    for (const action of availableActions) {
      const zodShape = buildZodShape(action);
      server.tool(action.name, action.description, zodShape, async (input) => {
        const response = await executeAction(
          sessionId,
          action.name,
          input as Record<string, unknown>,
          bridge,
          pendingRequests,
        );
        return { content: [{ type: 'text' as const, text: response }] };
      });
    }
  }

  return { server, pendingRequests };
}

/**
 * Build a Zod shape from an ActionDefinition's params.
 * Maps our ParamDef types to Zod validators.
 */
function buildZodShape(action: ActionDefinition): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [name, def] of Object.entries(action.params)) {
    let schema: z.ZodTypeAny;

    switch (def.type) {
      case 'number':
        schema = z.number().describe(def.description);
        break;
      case 'boolean':
        schema = z.boolean().describe(def.description);
        break;
      default:
        if (def.enum) {
          schema = z.enum(def.enum as [string, ...string[]]).describe(def.description);
        } else {
          schema = z.string().describe(def.description);
        }
        break;
    }

    if (!def.required) {
      schema = schema.optional();
    }

    shape[name] = schema;
  }

  return shape;
}
