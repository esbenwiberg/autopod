export type AcType = 'none' | 'api' | 'web';

export interface AcDefinition {
  type: AcType;
  /** Specific action to perform: "run `npx pnpm build`", "GET /pods/series/:id", "navigate to /pods" */
  test: string;
  /** Observable success condition: "exit code 0", "200 with pods array", "badge renders" */
  pass: string;
  /** Observable failure condition: "any TS errors", "non-200", "no badge visible" */
  fail: string;
}
