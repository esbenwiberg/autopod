export function createAgentRunRegistry() {
  const activeAgentRuns = new Map<
    string,
    {
      token: symbol;
      settled: Promise<void>;
      providerOrdinal?: number;
      taskRunId?: string;
      isCurrent?: () => boolean;
    }
  >();
  const activeAgentRunResolvers = new Map<string, { token: symbol; resolve: () => void }>();
  return { activeAgentRuns, activeAgentRunResolvers };
}
