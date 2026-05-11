export type AcType = 'none' | 'api' | 'web' | 'cmd';
export type AcPolarity = 'expect-output' | 'expect-no-output' | 'exit-zero';

/** Base fields shared by all AC types. */
interface AcBase {
  /** User-visible criterion description. Required, ≤200 chars. */
  outcome: string;
  /** Technical pointer consumed by the LLM and executors (URL, selector, endpoint, or shell command). ≤500 chars. */
  hint?: string;
}

export type AcDefinition =
  | (AcBase & { type: 'none' })
  | (AcBase & { type: 'api' })
  | (AcBase & { type: 'web' })
  | (AcBase & { type: 'cmd'; polarity?: AcPolarity });
