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
  /** Agent-reported task summary (what was done + deviations from plan) */
  taskSummary?: TaskSummary;
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
  } = config;

  const sections: string[] = [];

  // Summary
  sections.push(`## Summary\n\n${task}`);

  // Task Summary (agent-reported: what was done + deviations)
  if (taskSummary) {
    const lines: string[] = ['## Task Summary'];
    lines.push(`\n${taskSummary.actualSummary}`);

    if (taskSummary.deviations.length > 0) {
      lines.push('\n### Deviations from Plan');
      lines.push('');
      for (const d of taskSummary.deviations) {
        lines.push(`**${d.step}**`);
        lines.push(`- Planned: ${d.planned}`);
        lines.push(`- Actual: ${d.actual}`);
        lines.push(`- Reason: ${d.reason}`);
        lines.push('');
      }
    } else {
      lines.push('\n_No deviations from plan reported._');
    }

    // Reviewer's assessment of deviations (if available)
    const deviationsAssessment = validationResult?.taskReview?.deviationsAssessment;
    if (deviationsAssessment) {
      if (
        deviationsAssessment.disclosedDeviations.length > 0 ||
        deviationsAssessment.undisclosedDeviations.length > 0
      ) {
        lines.push('\n### Deviation Review');
        lines.push('');
        for (const d of deviationsAssessment.disclosedDeviations) {
          const verdictIcon =
            d.verdict === 'justified' ? '✅' : d.verdict === 'questionable' ? '⚠️' : '❌';
          lines.push(`> ${verdictIcon} **${d.step}** (${d.verdict}): ${d.reasoning}`);
        }
        if (deviationsAssessment.undisclosedDeviations.length > 0) {
          lines.push('');
          lines.push('> **Undisclosed deviations detected:**');
          for (const u of deviationsAssessment.undisclosedDeviations) {
            lines.push(`> ⚠️ ${u}`);
          }
        }
      }
    }

    sections.push(lines.join('\n'));
  }

  // Validation results
  if (validationResult) {
    const v = validationResult;
    const lines: string[] = ['## Validation'];

    const icon = (status: string) => (status === 'pass' ? '✅' : '❌');

    lines.push('\n| Phase | Status |');
    lines.push('|-------|--------|');
    lines.push(`| Build | ${icon(v.smoke.build.status)} ${v.smoke.build.status} |`);
    lines.push(`| Health check | ${icon(v.smoke.health.status)} ${v.smoke.health.status} |`);

    if (v.smoke.pages.length > 0) {
      const passed = v.smoke.pages.filter((p: { status: string }) => p.status === 'pass').length;
      const pageStatus = passed === v.smoke.pages.length ? 'pass' : 'fail';
      lines.push(
        `| Page validation | ${icon(pageStatus)} ${passed}/${v.smoke.pages.length} pages passed |`,
      );
    }

    if (v.taskReview) {
      lines.push(`| AI review | ${icon(v.taskReview.status)} ${v.taskReview.status} |`);
      if (v.taskReview.reasoning) {
        lines.push(`\n> ${v.taskReview.reasoning}`);
      }
      if (v.taskReview.requirementsCheck && v.taskReview.requirementsCheck.length > 0) {
        lines.push('');
        for (const req of v.taskReview.requirementsCheck) {
          const reqIcon = req.met ? '✅' : '❌';
          const note = req.note ? ` — ${req.note}` : '';
          lines.push(`> ${reqIcon} ${req.criterion}${note}`);
        }
      }
      if (v.taskReview.issues && v.taskReview.issues.length > 0) {
        lines.push('');
        for (const issue of v.taskReview.issues) {
          lines.push(`> ⚠️ ${issue}`);
        }
      }
    }

    lines.push(
      `\n**Overall: ${icon(v.overall)} ${v.overall}** (attempt ${v.attempt}, ${formatDuration(v.duration)})`,
    );
    sections.push(lines.join('\n'));
  }

  // Stats
  sections.push(
    `## Stats\n\n- **Files changed:** ${filesChanged}\n- **Lines:** +${linesAdded} / -${linesRemoved}`,
  );

  // Screenshots
  if (config.screenshots && config.screenshots.length > 0) {
    const imgs = config.screenshots.map(
      (s) => `### \`${s.pagePath}\`\n![${s.pagePath}](${s.imageUrl})`,
    );
    sections.push(`## Screenshots\n\n${imgs.join('\n\n')}`);
  }

  // Preview
  if (previewUrl) {
    sections.push(`## Preview\n\n[Open preview](${previewUrl})`);
  }

  // Footer
  sections.push(
    `---\n🤖 Created by [autopod](https://github.com/esbenwiberg/autopod) session \`${sessionId}\` (profile: \`${profileName}\`)`,
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
