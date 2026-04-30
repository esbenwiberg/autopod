import type { ScanFinding, TaskSummary, ValidationResult } from '@autopod/shared';
import type { PrNarrative } from './pr-description-generator.js';

export interface ScreenshotRef {
  /** Page path (e.g. '/', '/about') */
  pagePath: string;
  /** Full URL to the screenshot image (GitHub raw URL) */
  imageUrl: string;
}

export interface PrBodyConfig {
  task: string;
  podId: string;
  profileName: string;
  validationResult: ValidationResult | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  previewUrl: string | null;
  /** Screenshot references for embedding in the PR body */
  screenshots?: ScreenshotRef[];
  /** Agent-reported task summary (what was done + how + deviations from plan) */
  taskSummary?: TaskSummary;
  /**
   * Whether to embed screenshots as inline images (`![](url)`).
   * Set to false for platforms that don't render external images (e.g. Azure DevOps).
   * Defaults to true.
   */
  inlineImages?: boolean;
  /** Series-level description (from context.md). When set, replaces task in the "Why" section. */
  seriesDescription?: string;
  /** Human-readable series name. Used with seriesDescription to build the PR title. */
  seriesName?: string;
  /** Security scan findings to render as a Security Notice section. */
  securityFindings?: ScanFinding[];
  /**
   * LLM-generated narrative sections. When provided, overrides the template-based Why/What/How
   * derived from task and taskSummary. reviewFocus adds a "Review Focus" section.
   */
  narrative?: PrNarrative;
  /**
   * Maximum character budget for the rendered body. When set, lower-priority sections are
   * dropped (rather than truncated mid-sentence) until the body fits within the budget.
   * Drop order: screenshots → previewUrl → deviations table → AI review details block.
   */
  budgetChars?: number;
}

/**
 * Escape agent-supplied text before embedding it in a GitHub/ADO PR body.
 *
 * Prevents the agent from injecting markdown that could mislead reviewers:
 *   - @mentions that notify teams (e.g. `@security-team`)
 *   - link syntax that could redirect reviewers ([legit text](evil-url))
 *   - HTML tags that some renderers pass through (<script>, <img ...>)
 *   - Backtick/pipe/underscore/asterisk that break table or code formatting
 *   - Heading markers that would create unexpected structure
 *
 * This is intentionally narrow: it escapes inline injection vectors without
 * stripping all markdown (we still want the agent's prose to render naturally).
 */
export function escapeMd(text: string): string {
  return (
    text
      // @ mentions: neutralise with a zero-width space after the @
      .replace(/@([A-Za-z0-9_-])/g, '@​$1')
      // HTML tags
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Link syntax [text](url) — escape the bracket pair
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '\\[$1\\]($2)')
      // Pipe character breaks table cells
      .replace(/\|/g, '\\|')
      // Backtick (inline code injection)
      .replace(/`/g, '\\`')
  );
}

export function buildPrTitle(
  task: string,
  seriesName?: string,
  seriesDescription?: string,
): string {
  // For series PRs with a description, use the series name as a clean short title
  if (seriesDescription && seriesName) {
    const clean = seriesName.replace(/[-_]/g, ' ').trim();
    const hasPrefix = /^(feat|fix|chore|refactor|docs|test|ci|style|perf)(\(.+\))?:/i.test(clean);
    const titled = hasPrefix ? clean : `feat: ${clean}`;
    return titled.length > 70 ? `${titled.slice(0, 67)}...` : titled;
  }
  // Truncate at 70 chars, prefix with "feat:" if not already prefixed
  const clean = task.replace(/\n/g, ' ').trim();
  const hasPrefix = /^(feat|fix|chore|refactor|docs|test|ci|style|perf)(\(.+\))?:/i.test(clean);
  const titled = hasPrefix ? clean : `feat: ${clean}`;
  return titled.length > 70 ? `${titled.slice(0, 67)}...` : titled;
}

export function buildPrBody(config: PrBodyConfig): string {
  const {
    task,
    podId,
    profileName,
    validationResult,
    filesChanged,
    linesAdded,
    linesRemoved,
    previewUrl,
    taskSummary,
    inlineImages = true,
    seriesDescription,
    narrative,
    budgetChars,
  } = config;

  // Resolve narrative sources — LLM-generated narrative wins over template fallbacks
  const whyText = narrative ? narrative.why : (seriesDescription ?? task);
  const whatText = narrative ? narrative.what : taskSummary?.actualSummary;
  const howText = narrative ? narrative.how : taskSummary?.how;
  const reviewFocus = narrative?.reviewFocus;

  const sections: string[] = [];

  // ── Narrative: Why / What / How / Review Focus ────────────────────────────

  sections.push(`## Why\n\n${escapeMd(whyText)}`);

  if (whatText) {
    sections.push(`## What\n\n${escapeMd(whatText)}`);
  }

  if (howText) {
    sections.push(`## How\n\n${escapeMd(howText)}`);
  }

  if (reviewFocus && reviewFocus.length > 0) {
    const items = reviewFocus.map((f) => `- ${escapeMd(f)}`).join('\n');
    sections.push(`## Review Focus\n\n${items}`);
  }

  // ── Reviewer sections ─────────────────────────────────────────────────────

  // Concerns: surfaces issues and problematic deviations upfront
  const concernLines: string[] = [];

  const aiIssues = validationResult?.taskReview?.issues ?? [];
  for (const issue of aiIssues) {
    concernLines.push(`- ⚠️ ${escapeMd(issue)}`);
  }

  const deviationsAssessment = validationResult?.taskReview?.deviationsAssessment;
  if (deviationsAssessment) {
    for (const d of deviationsAssessment.disclosedDeviations) {
      if (d.verdict === 'questionable' || d.verdict === 'unjustified') {
        const icon = d.verdict === 'unjustified' ? '❌' : '⚠️';
        concernLines.push(
          `- ${icon} **${escapeMd(d.step)}** (${d.verdict}): ${escapeMd(d.reasoning)}`,
        );
      }
    }
    for (const u of deviationsAssessment.undisclosedDeviations) {
      concernLines.push(`- ⚠️ Undisclosed deviation: ${escapeMd(u)}`);
    }
  }

  if (concernLines.length > 0) {
    sections.push(`## ⚠️ Concerns\n\n${concernLines.join('\n')}`);
  }

  // Review Checklist
  const requirementsCheck = validationResult?.taskReview?.requirementsCheck;
  if (requirementsCheck && requirementsCheck.length > 0) {
    const checklistLines = requirementsCheck.map((req) => {
      const check = req.met ? '[x]' : '[ ]';
      const icon = req.met ? '✅' : '❌';
      const note = req.note ? ` — ${escapeMd(req.note)}` : '';
      return `- ${check} ${icon} ${escapeMd(req.criterion)}${note}`;
    });
    sections.push(`## Review Checklist\n\n${checklistLines.join('\n')}`);
  }

  // Deviations from Plan (table format)
  if (taskSummary && taskSummary.deviations.length > 0) {
    const hasVerdicts = deviationsAssessment && deviationsAssessment.disclosedDeviations.length > 0;

    const verdictMap = new Map<
      string,
      { verdict: 'justified' | 'questionable' | 'unjustified'; reasoning: string }
    >();
    if (deviationsAssessment) {
      for (const d of deviationsAssessment.disclosedDeviations) {
        verdictMap.set(d.step, { verdict: d.verdict, reasoning: d.reasoning });
      }
    }

    const lines: string[] = [];
    if (hasVerdicts) {
      lines.push('| Step | Planned | Actual | Reason | Verdict |');
      lines.push('|------|---------|--------|--------|---------|');
    } else {
      lines.push('| Step | Planned | Actual | Reason |');
      lines.push('|------|---------|--------|--------|');
    }

    for (const d of taskSummary.deviations) {
      if (hasVerdicts) {
        const v = verdictMap.get(d.step);
        const verdictCell = v
          ? `${v.verdict === 'justified' ? '✅' : v.verdict === 'questionable' ? '⚠️' : '❌'} ${v.verdict}`
          : '—';
        lines.push(
          `| ${escapeMd(d.step)} | ${escapeMd(d.planned)} | ${escapeMd(d.actual)} | ${escapeMd(d.reason)} | ${verdictCell} |`,
        );
      } else {
        lines.push(
          `| ${escapeMd(d.step)} | ${escapeMd(d.planned)} | ${escapeMd(d.actual)} | ${escapeMd(d.reason)} |`,
        );
      }
    }

    sections.push(`## Deviations from Plan\n\n${lines.join('\n')}`);
  }

  // ── Automated results ─────────────────────────────────────────────────────

  if (validationResult) {
    const v = validationResult;
    const icon = (status: string) => (status === 'pass' ? '✅' : '❌');

    const tableLines: string[] = [];
    tableLines.push('| Phase | Status |');
    tableLines.push('|-------|--------|');
    tableLines.push(`| Build | ${icon(v.smoke.build.status)} ${v.smoke.build.status} |`);
    tableLines.push(`| Health check | ${icon(v.smoke.health.status)} ${v.smoke.health.status} |`);

    if (v.smoke.pages.length > 0) {
      const passed = v.smoke.pages.filter((p: { status: string }) => p.status === 'pass').length;
      const pageStatus = passed === v.smoke.pages.length ? 'pass' : 'fail';
      tableLines.push(
        `| Page validation | ${icon(pageStatus)} ${passed}/${v.smoke.pages.length} pages passed |`,
      );
    }

    if (v.taskReview) {
      tableLines.push(`| AI review | ${icon(v.taskReview.status)} ${v.taskReview.status} |`);
    }

    const overallLine = `\n**Overall: ${icon(v.overall)} ${v.overall}** (attempt ${v.attempt}, ${formatDuration(v.duration)})`;

    let validationSection = `## Validation\n\n${tableLines.join('\n')}${overallLine}`;

    if (v.taskReview?.reasoning) {
      validationSection += `\n\n<details>\n<summary>AI Review Details</summary>\n\n${v.taskReview.reasoning}\n\n</details>`;
    }

    sections.push(validationSection);
  }

  // ── Security findings (pre-push scan) ─────────────────────────────────────

  if (config.securityFindings && config.securityFindings.length > 0) {
    sections.push(formatSecurityNotice(config.securityFindings));
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  sections.push(
    `## Stats\n\n\`${filesChanged} files\` · \`+${linesAdded}\` / \`-${linesRemoved}\``,
  );

  if (config.screenshots && config.screenshots.length > 0) {
    const imgs = config.screenshots.map((s) => {
      if (inlineImages) {
        return `### \`${s.pagePath}\`\n![${s.pagePath}](${s.imageUrl})`;
      }
      return `### \`${s.pagePath}\`\n[View screenshot](${s.imageUrl})`;
    });
    sections.push(`## Screenshots\n\n${imgs.join('\n\n')}`);
  }

  if (previewUrl) {
    sections.push(`## Preview\n\n[Open preview](${previewUrl})`);
  }

  sections.push(
    `---\n🤖 Created by [autopod](https://github.com/esbenwiberg/autopod) · pod \`${podId}\` · profile \`${profileName}\``,
  );

  if (budgetChars) {
    return applyBudget(sections, budgetChars);
  }
  return sections.join('\n\n');
}

/**
 * Drop lower-priority sections (screenshots → preview → deviations → AI review details)
 * until the joined body fits within budgetChars. Sections are dropped whole — no mid-sentence cuts.
 */
function applyBudget(sections: string[], budgetChars: number): string {
  const join = (s: string[]) => s.join('\n\n');

  if (join(sections).length <= budgetChars) return join(sections);

  // Drop order: least informative for a reviewer first
  const dropPrefixes = [
    '## Screenshots',
    '## Preview',
    '## Deviations from Plan',
  ];

  for (const prefix of dropPrefixes) {
    const filtered = sections.filter((s) => !s.startsWith(prefix));
    if (filtered.length !== sections.length) {
      sections = filtered;
      if (join(sections).length <= budgetChars) return join(sections);
    }
  }

  // Strip the <details> block from the Validation section
  sections = sections.map((s) =>
    s.startsWith('## Validation')
      ? s.replace(/\n\n<details>[\s\S]*?<\/details>/g, '')
      : s,
  );
  if (join(sections).length <= budgetChars) return join(sections);

  // Last resort: hard-truncate the body (shouldn't be needed after the drops above)
  return join(sections).slice(0, budgetChars);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function formatSecurityNotice(findings: ScanFinding[]): string {
  const byDetector = new Map<string, ScanFinding[]>();
  for (const f of findings) {
    const list = byDetector.get(f.detector) ?? [];
    list.push(f);
    byDetector.set(f.detector, list);
  }

  const lines: string[] = [
    '## ⚠️ Security Notice',
    '',
    'Automated pre-push scanning flagged the following content. Reviewers should',
    'verify that no real secrets, PII, or prompt-injection payloads land in the',
    'merged branch.',
  ];

  for (const detector of ['secrets', 'pii', 'injection'] as const) {
    const list = byDetector.get(detector);
    if (!list || list.length === 0) continue;
    lines.push('', `### ${labelFor(detector)}`);
    for (const f of list) {
      const safePath = f.file.replace(/[`*_[\]<>]/g, (c) => `\\${c}`);
      const loc = f.line !== undefined ? `:${f.line}` : '';
      const confidence =
        f.confidence !== undefined ? ` (confidence ${f.confidence.toFixed(2)})` : '';
      const rule = f.ruleId ? ` — ${f.ruleId}` : '';
      lines.push(`- \`${safePath}${loc}\`${confidence}${rule}`);
    }
  }

  return lines.join('\n');
}

function labelFor(detector: 'secrets' | 'pii' | 'injection'): string {
  switch (detector) {
    case 'secrets':
      return 'Potential secrets';
    case 'pii':
      return 'Potential PII';
    case 'injection':
      return 'Potential prompt injection';
  }
}
