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
  /** Optional classification for faster reviewer triage. */
  kind?: 'constraint' | 'tradeoff' | 'scope' | 'bugfix' | 'other';
  /** Optional impact summary the reviewer should verify in the diff. */
  impact?: string;
}

/** Agent-reported task summary submitted via report_task_summary before finishing. */
export interface TaskSummary {
  /** High-level description of what was actually accomplished */
  actualSummary: string;
  /** Implementation approach — key technical decisions, libraries chosen, patterns used */
  how?: string;
  /** Deviations from the original plan, if any */
  deviations: DeviationItem[];
  /** Agent-reported fact evidence. Validator re-runs commands; this is context only. */
  factEvidence?: FactEvidence[];
  /** Optional requests to waive/replace required facts that are impossible under current reality. */
  factDeviations?: FactDeviationRequest[];
}

export interface FactDeviationRequest {
  factId: string;
  action: 'waive' | 'replace';
  reason: string;
  whyImpossible: string;
  /** Human decision (single user) for this pod-scoped request. */
  decision?: 'approved_waive' | 'approved_replace' | 'rejected';
  replacement?: {
    artifactPath: string;
    command: string;
    proves?: string[];
  };
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
import type { FactEvidence } from './contract.js';
