export function buildDetachedMcpFallbackMessage(
  escalationType: string | undefined,
  response: string,
): string {
  const label = escalationType ? `${escalationType} MCP call` : 'MCP call';
  return [
    `Fallback response for the previous ${label}:`,
    '',
    response,
    '',
    'The original MCP response stream closed before this answer could be delivered. If you already received the same answer directly from the tool call, ignore this duplicate.',
  ].join('\n');
}
