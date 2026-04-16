import type { TaskSummary, ValidationResult } from '@autopod/shared';

export interface ScreenshotRef {
  /** Page path (e.g. '/', '/about') */
  pagePath: string;
  /** Full URL to the screenshot image (GitHub raw URL) */
  imageUrl: string;
}

export interface PrBodyConfig {
  task: string;
  sessionId: string;
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
}

export function buildPrTitle(task: string): string {
  // Truncate at 70 chars, prefix with "feat:" if not already prefixed
  const clean = task.replace(/\n/g, ' ').trim();
  const hasPrefix = /^(feat|fix|chore|refactor|docs|test|ci|style|perf)(\(.+\))?:/i.test(clean);
  const titled = hasPrefix ? clean : `feat: ${clean}`;
  return titled.length > 70 ? `${titled.slice(0, 67)}...` : titled;
}

export function buildPrBody(config: PrBodyConfig): string {
  const {
    task,
    sessionId,
    profileName,
    validationResult,
    filesChanged,
    linesAdded,
    linesRemoved,
    previewUrl,
    taskSummary,
    inlineImages = true,
  } = config;

  const sections: string[] = [];

  // ── Narrative: Why / What / How ──────────────────────────────────────────

  sections.push(`## Why\n\n${task}`);

  if (taskSummary) {
    sections.push(`## What\n\n${taskSummary.actualSummary}`);

    if (taskSummary.how) {
      sections.push(`## How\n\n${taskSummary.how}`);
    }
  }

  // ── Reviewer sections ─────────────────────────────────────────────────────

  // Concerns: surfaces issues and problematic deviations upfront
  const concernLines: string[] = [];

  const aiIssues = validationResult?.taskReview?.issues ?? [];
  for (const issue of aiIssues) {
    concernLines.push(`- ⚠️ ${issue}`);
  }

  const deviationsAssessment = validationResult?.taskReview?.deviationsAssessment;
  if (deviationsAssessment) {
    for (const d of deviationsAssessment.disclosedDeviations) {
      if (d.verdict === 'questionable' || d.verdict === 'unjustified') {
        const icon = d.verdict === 'unjustified' ? '❌' : '⚠️';
        concernLines.push(`- ${icon} **${d.step}** (${d.verdict}): ${d.reasoning}`);
      }
    }
    for (const u of deviationsAssessment.undisclosedDeviations) {
      concernLines.push(`- ⚠️ Undisclosed deviation: ${u}`);
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
      const note = req.note ? ` — ${req.note}` : '';
      return `- ${check} ${icon} ${req.criterion}${note}`;
    });
    sections.push(`## Review Checklist\n\n${checklistLines.join('\n')}`);
  }

  // Deviations from Plan (table format)
  if (taskSummary && taskSummary.deviations.length > 0) {
    const hasVerdicts =
      deviationsAssessment && deviationsAssessment.disclosedDeviations.length > 0;

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
          `| ${d.step} | ${d.planned} | ${d.actual} | ${d.reason} | ${verdictCell} |`,
        );
      } else {
        lines.push(`| ${d.step} | ${d.planned} | ${d.actual} | ${d.reason} |`);
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
    tableLines.push(
      `| Health check | ${icon(v.smoke.health.status)} ${v.smoke.health.status} |`,
    );

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

  // ── Meta ──────────────────────────────────────────────────────────────────

  sections.push(`## Stats\n\n\`${filesChanged} files\` · \`+${linesAdded}\` / \`-${linesRemoved}\``);

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
    `---\n🤖 Created by [autopod](https://github.com/esbenwiberg/autopod) · session \`${sessionId}\` · profile \`${profileName}\``,
  );

  return sections.join('\n\n');
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
