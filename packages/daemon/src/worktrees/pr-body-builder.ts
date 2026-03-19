import type { ValidationResult } from '@autopod/shared';

export interface PrBodyConfig {
  task: string;
  sessionId: string;
  profileName: string;
  validationResult: ValidationResult | null;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  previewUrl: string | null;
}

export function buildPrTitle(task: string): string {
  // Truncate at 70 chars, prefix with "feat:" if not already prefixed
  const clean = task.replace(/\n/g, ' ').trim();
  const hasPrefix = /^(feat|fix|chore|refactor|docs|test|ci|style|perf)(\(.+\))?:/i.test(clean);
  const titled = hasPrefix ? clean : `feat: ${clean}`;
  return titled.length > 70 ? `${titled.slice(0, 67)}...` : titled;
}

export function buildPrBody(config: PrBodyConfig): string {
  const { task, sessionId, profileName, validationResult, filesChanged, linesAdded, linesRemoved, previewUrl } = config;

  const sections: string[] = [];

  // Summary
  sections.push(`## Summary\n\n${task}`);

  // Validation results
  if (validationResult) {
    const v = validationResult;
    const lines: string[] = ['## Validation'];

    const icon = (status: string) => status === 'pass' ? '✅' : '❌';

    lines.push(`\n| Phase | Status |`);
    lines.push(`|-------|--------|`);
    lines.push(`| Build | ${icon(v.smoke.build.status)} ${v.smoke.build.status} |`);
    lines.push(`| Health check | ${icon(v.smoke.health.status)} ${v.smoke.health.status} |`);

    if (v.smoke.pages.length > 0) {
      const passed = v.smoke.pages.filter((p: { status: string }) => p.status === 'pass').length;
      const pageStatus = passed === v.smoke.pages.length ? 'pass' : 'fail';
      lines.push(`| Page validation | ${icon(pageStatus)} ${passed}/${v.smoke.pages.length} pages passed |`);
    }

    if (v.taskReview) {
      lines.push(`| AI review | ${icon(v.taskReview.status)} ${v.taskReview.status} |`);
      if (v.taskReview.reasoning) {
        lines.push(`\n> ${v.taskReview.reasoning}`);
      }
    }

    lines.push(`\n**Overall: ${icon(v.overall)} ${v.overall}** (attempt ${v.attempt}, ${formatDuration(v.duration)})`);
    sections.push(lines.join('\n'));
  }

  // Stats
  sections.push(
    `## Stats\n\n` +
    `- **Files changed:** ${filesChanged}\n` +
    `- **Lines:** +${linesAdded} / -${linesRemoved}`,
  );

  // Preview
  if (previewUrl) {
    sections.push(`## Preview\n\n[Open preview](${previewUrl})`);
  }

  // Footer
  sections.push(
    `---\n` +
    `🤖 Created by [autopod](https://github.com/esbenwiberg/autopod) ` +
    `session \`${sessionId}\` (profile: \`${profileName}\`)`,
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
