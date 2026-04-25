import path from 'node:path';
import type { ScanFinding, ScanSeverity } from '@autopod/shared';
import { lintSource } from '@secretlint/core';
import { creator as recommendPresetCreator } from '@secretlint/secretlint-rule-preset-recommend';
import type { ScanFile } from '../file-walker.js';
import type { Detector } from './detector.js';

/**
 * Secretlint-backed detector. Uses the official `@secretlint/core` runner
 * with the recommended preset (covers AWS, GCP, GitHub, Slack, NPM, Stripe,
 * Twilio, ADO, Azure, Discord, etc.).
 *
 * We never store the raw secret value — the `snippet` field is constructed
 * from a 4-character prefix of the matched range plus a `[REDACTED]` marker
 * so a human can navigate (file + line) without leaking the value.
 */
export function createSecretlintDetector(): Detector {
  // The recommended preset disables `enableIDScanRule` for the AWS rule by
  // default (it's noisier than the secret-access-key rule). For autopod's
  // threat model — agent-authored code that should never contain *any*
  // hardcoded credentials — we want the ID scan on. Other sub-rules use
  // their preset defaults.
  const config = {
    rules: [
      {
        id: '@secretlint/secretlint-rule-preset-recommend',
        rule: recommendPresetCreator,
        rules: [
          {
            id: '@secretlint/secretlint-rule-aws',
            options: { enableIDScanRule: true },
          },
        ],
      },
    ],
  };

  return {
    name: 'secrets',
    async warmup() {
      // Rules are imported eagerly; nothing to do.
    },
    async scan(file: ScanFile): Promise<ScanFinding[]> {
      try {
        const result = await lintSource({
          source: {
            content: file.content,
            filePath: file.path,
            ext: path.extname(file.path),
            contentType: 'text',
          },
          options: {
            config,
            // We mask snippets ourselves to keep redaction policy in our hands.
            maskSecrets: false,
          },
        });

        const findings: ScanFinding[] = [];
        for (const msg of result.messages) {
          if (msg.type !== 'message') continue;
          findings.push({
            detector: 'secrets',
            severity: severityFromSecretlint(msg.severity),
            file: file.path,
            line: msg.loc.start.line,
            ruleId: msg.ruleId,
            snippet: redactSnippet(file.content, msg.range),
          });
        }
        return findings;
      } catch {
        // Detector contract: never throw.
        return [];
      }
    },
  };
}

function severityFromSecretlint(level: 'info' | 'warning' | 'error'): ScanSeverity {
  switch (level) {
    case 'error':
      return 'critical';
    case 'warning':
      return 'high';
    case 'info':
      return 'medium';
  }
}

/**
 * Build a redacted snippet from the matched range. We keep the rule id in the
 * Finding for context — the snippet exists for navigation/audit, not analysis.
 * Format: `<first 4 chars of match>...[REDACTED]` (or `[REDACTED]` if shorter).
 */
function redactSnippet(content: string, range: readonly [number, number]): string {
  const [start, end] = range;
  const matched = content.slice(start, end);
  if (matched.length <= 4) return '[REDACTED]';
  return `${matched.slice(0, 4)}...[REDACTED]`;
}
