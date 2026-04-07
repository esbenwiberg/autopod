/** A single deviation from the original plan, as reported by the agent. */
export interface DeviationItem {
  /** The original plan step that was deviated from (e.g. "Step 2") */
  step: string;
  /** What was originally planned */
  planned: string;
  /** What was actually done instead */
  actual: string;
  /** Why the deviation was necessary */
  reason: string;
}

/** Agent-reported task summary submitted via report_task_summary before finishing. */
export interface TaskSummary {
  /** High-level description of what was actually accomplished */
  actualSummary: string;
  /** Deviations from the original plan, if any */
  deviations: DeviationItem[];
}

/** Reviewer's assessment of reported (and detected) deviations. */
export interface DeviationsAssessment {
  /** Deviations the agent disclosed and the reviewer's verdict on each */
  disclosedDeviations: Array<{
    step: string;
    reasoning: string;
    verdict: 'justified' | 'questionable' | 'unjustified';
  }>;
  /** Deviations the reviewer detected in the diff that were NOT disclosed by the agent */
  undisclosedDeviations: string[];
}
