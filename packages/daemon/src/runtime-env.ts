export const RUNTIME_TELEMETRY_OPT_OUT_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DO_NOT_TRACK: '1',
  VERCEL_TELEMETRY_DISABLED: '1',
  NEXT_TELEMETRY_DISABLED: '1',
} as const;

export function withRuntimeTelemetryOptOutEnv(
  env: Record<string, string> = {},
): Record<string, string> {
  return { ...RUNTIME_TELEMETRY_OPT_OUT_ENV, ...env };
}
