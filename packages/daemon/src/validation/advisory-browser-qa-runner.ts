import type {
  AdvisoryBrowserQaObservation,
  AdvisoryBrowserQaResult,
  HumanReviewItem,
  ScreenshotRef,
  SpecContract,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import { ClaudeCliError, runClaudeCli } from '../runtimes/run-claude-cli.js';
import type { HostBrowserRunner } from './host-browser-runner.js';

export const ADVISORY_BROWSER_QA_TARGET_CAP = 5;

type AdvisoryChecklistTarget =
  | {
      id: string;
      type: 'scenario';
      scenarioId: string;
      prompt: string;
    }
  | {
      id: string;
      type: 'human_review';
      prompt: string;
      covers: string[];
    };

interface BrowserObservation {
  targetId: string;
  url: string;
  title: string;
  notes: string[];
  screenshotPath?: string;
  error?: string;
}

export interface AdvisoryBrowserQaReviewInput {
  task: string;
  baseUrl: string;
  targets: AdvisoryChecklistTarget[];
  browserObservations: Array<
    Omit<BrowserObservation, 'screenshotPath'> & { screenshots: ScreenshotRef[] }
  >;
}

export interface AdvisoryBrowserQaReviewer {
  review(input: AdvisoryBrowserQaReviewInput): Promise<{
    status: 'pass' | 'fail' | 'uncertain';
    reasoning: string;
    observations: Array<{
      id?: string;
      targetId?: string;
      status: 'pass' | 'fail' | 'uncertain';
      summary: string;
      details?: string;
      suggestedFacts?: string[];
    }>;
  }>;
}

export interface AdvisoryBrowserQaRunnerOptions {
  podId: string;
  task: string;
  baseUrl: string;
  contract?: SpecContract;
  reviewerModel?: string;
  timeoutMs?: number;
  hostBrowserRunner?: HostBrowserRunner;
  screenshotStore?: ScreenshotStore;
  reviewer?: AdvisoryBrowserQaReviewer;
  logger?: Logger;
}

export function buildAdvisoryChecklistTargets(
  contract: SpecContract | undefined,
): AdvisoryChecklistTarget[] {
  if (!contract) return [];

  const scenarioTargets: AdvisoryChecklistTarget[] = contract.scenarios.map((scenario) => ({
    id: `scenario:${scenario.id}`,
    type: 'scenario',
    scenarioId: scenario.id,
    prompt: [
      `Scenario ${scenario.id}`,
      `Given: ${scenario.given.join(' / ')}`,
      `When: ${scenario.when.join(' / ')}`,
      `Then: ${scenario.then.join(' / ')}`,
    ].join('\n'),
  }));

  const humanReviewTargets: AdvisoryChecklistTarget[] = contract.humanReview.map((item) => ({
    id: `human_review:${item.id}`,
    type: 'human_review',
    prompt: formatHumanReviewTarget(item),
    covers: item.covers,
  }));

  return [...scenarioTargets, ...humanReviewTargets].slice(0, ADVISORY_BROWSER_QA_TARGET_CAP);
}

function formatHumanReviewTarget(item: HumanReviewItem): string {
  return [
    `Human review ${item.id}`,
    `Covers: ${item.covers.join(', ') || 'none'}`,
    `Criterion: ${item.criterion}`,
    `Reason: ${item.reason}`,
  ].join('\n');
}

export async function runAdvisoryBrowserQa(
  options: AdvisoryBrowserQaRunnerOptions,
): Promise<AdvisoryBrowserQaResult> {
  const start = Date.now();
  const log = options.logger?.child({ component: 'advisory-browser-qa-runner' });
  const targets = buildAdvisoryChecklistTargets(options.contract);

  if (targets.length === 0) {
    return skipResult('no-contract-checklist', start);
  }
  if (!options.hostBrowserRunner) {
    return skipResult('host-browser-unavailable', start);
  }
  if (!options.screenshotStore) {
    return skipResult('screenshot-store-unavailable', start);
  }

  const availability = await options.hostBrowserRunner.getAvailability();
  if (!availability.available) {
    return skipResult(`host-browser-unavailable: ${availability.reason}`, start);
  }

  try {
    const screenshotDir = options.hostBrowserRunner.screenshotDir(options.podId);
    const script = buildBrowserScript({
      baseUrl: options.baseUrl,
      screenshotDir,
      targets,
    });
    const run = await options.hostBrowserRunner.runScript(script, {
      podId: options.podId,
      timeout: options.timeoutMs ?? 120_000,
    });
    const observations = parseBrowserObservations(run.stdout);
    if (run.exitCode !== 0 && observations.length === 0) {
      return {
        status: 'uncertain',
        reasoning: `Advisory browser QA script failed: ${run.stderr.slice(0, 1_000)}`,
        durationMs: Date.now() - start,
        observations: [],
        screenshots: [],
      };
    }

    const screenshotByTarget = await collectAdvisoryScreenshots(
      observations,
      options.hostBrowserRunner,
      options.screenshotStore,
      options.podId,
      log,
    );
    const reviewer = options.reviewer ?? createClaudeAdvisoryReviewer(options.reviewerModel);
    const review = await reviewer.review({
      task: options.task,
      baseUrl: options.baseUrl,
      targets,
      browserObservations: observations.map((observation) => ({
        targetId: observation.targetId,
        url: observation.url,
        title: observation.title,
        notes: observation.notes,
        error: observation.error,
        screenshots: screenshotByTarget.get(observation.targetId) ?? [],
      })),
    });

    const targetById = new Map(targets.map((target) => [target.id, target]));
    const advisoryObservations: AdvisoryBrowserQaObservation[] = review.observations.map(
      (observation, index) => {
        const targetId = observation.targetId;
        const target = targetId ? targetById.get(targetId) : undefined;
        return {
          id: observation.id ?? `advisory-${index + 1}`,
          scenarioId: target?.type === 'scenario' ? target.scenarioId : undefined,
          status: observation.status,
          summary: observation.summary,
          details: observation.details,
          screenshots: targetId ? (screenshotByTarget.get(targetId) ?? []) : [],
          suggestedFacts: observation.suggestedFacts,
        };
      },
    );
    const screenshots = [
      ...new Map(
        [...screenshotByTarget.values()].flat().map((ref) => [ref.relativePath, ref]),
      ).values(),
    ];

    return {
      status: review.status,
      reasoning: review.reasoning,
      model: options.reviewerModel,
      durationMs: Date.now() - start,
      observations: advisoryObservations,
      screenshots,
    };
  } catch (err) {
    log?.warn({ err }, 'advisory browser QA failed');
    return {
      status: 'uncertain',
      reasoning: `Advisory browser QA error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
      observations: [],
      screenshots: [],
    };
  }
}

function skipResult(reason: string, start: number): AdvisoryBrowserQaResult {
  return {
    status: 'skip',
    reasoning: reason,
    durationMs: Date.now() - start,
    observations: [],
    screenshots: [],
  };
}

function buildBrowserScript(input: {
  baseUrl: string;
  screenshotDir: string;
  targets: AdvisoryChecklistTarget[];
}): string {
  return `
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = ${JSON.stringify(input.baseUrl)};
const screenshotDir = ${JSON.stringify(input.screenshotDir)};
const targets = ${JSON.stringify(input.targets)};

await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

try {
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const page = await browser.newPage({ locale: 'en-US' });
    const screenshotPath = join(screenshotDir, 'advisory-' + i + '.png');
    const notes = [];
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      notes.push('Reached ' + page.url());
      notes.push((await page.locator('body').innerText({ timeout: 5000 })).slice(0, 2000));
      await page.screenshot({ path: screenshotPath, fullPage: true });
      results.push({
        targetId: target.id,
        url: page.url(),
        title: await page.title(),
        notes,
        screenshotPath,
      });
    } catch (err) {
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {}
      results.push({
        targetId: target.id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        notes,
        screenshotPath,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log('AUTOPOD_ADVISORY_BROWSER_QA_JSON_START');
console.log(JSON.stringify(results));
console.log('AUTOPOD_ADVISORY_BROWSER_QA_JSON_END');
`;
}

function parseBrowserObservations(stdout: string): BrowserObservation[] {
  const match = stdout.match(
    /AUTOPOD_ADVISORY_BROWSER_QA_JSON_START\s*([\s\S]*?)\s*AUTOPOD_ADVISORY_BROWSER_QA_JSON_END/,
  );
  if (!match?.[1]) return [];
  const parsed = JSON.parse(match[1]) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      targetId: typeof item.targetId === 'string' ? item.targetId : '',
      url: typeof item.url === 'string' ? item.url : '',
      title: typeof item.title === 'string' ? item.title : '',
      notes: Array.isArray(item.notes)
        ? item.notes.filter((note): note is string => typeof note === 'string')
        : [],
      screenshotPath: typeof item.screenshotPath === 'string' ? item.screenshotPath : undefined,
      error: typeof item.error === 'string' ? item.error : undefined,
    }))
    .filter((item) => item.targetId);
}

async function collectAdvisoryScreenshots(
  observations: BrowserObservation[],
  hostBrowserRunner: HostBrowserRunner,
  screenshotStore: ScreenshotStore,
  podId: string,
  log?: Logger,
): Promise<Map<string, ScreenshotRef[]>> {
  const refs = new Map<string, ScreenshotRef[]>();

  for (let index = 0; index < observations.length; index++) {
    const observation = observations[index];
    if (!observation?.screenshotPath) continue;

    try {
      const base64 = await hostBrowserRunner.readScreenshot(observation.screenshotPath);
      const ref = await screenshotStore.write(
        podId,
        'advisory',
        `advisory-${index}.png`,
        Buffer.from(base64, 'base64'),
      );
      refs.set(observation.targetId, [...(refs.get(observation.targetId) ?? []), ref]);
    } catch (err) {
      log?.warn({ err, targetId: observation.targetId }, 'failed to collect advisory screenshot');
    }
  }

  return refs;
}

function createClaudeAdvisoryReviewer(model: string | undefined): AdvisoryBrowserQaReviewer {
  return {
    async review(input) {
      if (!model) {
        return {
          status: 'uncertain',
          reasoning: 'No reviewer model configured for advisory browser QA',
          observations: [],
        };
      }

      const prompt = buildReviewerPrompt(input);
      try {
        const { stdout } = await runClaudeCli({
          model,
          input: prompt,
          timeout: 120_000,
        });
        const parsed = parseReviewerJson(stdout);
        if (parsed) return parsed;
        return {
          status: 'uncertain',
          reasoning: 'Advisory browser QA reviewer returned malformed JSON',
          observations: [],
        };
      } catch (err) {
        const detail =
          err instanceof ClaudeCliError
            ? `${err.kind}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          status: 'uncertain',
          reasoning: `Advisory browser QA reviewer failed: ${detail}`,
          observations: [],
        };
      }
    },
  };
}

function buildReviewerPrompt(input: AdvisoryBrowserQaReviewInput): string {
  return `You are doing advisory browser QA for a running web app. This is non-blocking evidence only.

Task:
${input.task}

Base URL:
${input.baseUrl}

Checklist targets:
${input.targets.map((target, index) => `${index + 1}. ${target.id}\n${target.prompt}`).join('\n\n')}

Browser observations:
${input.browserObservations
  .map(
    (observation, index) =>
      `${index + 1}. ${observation.targetId}
URL: ${observation.url}
Title: ${observation.title}
Error: ${observation.error ?? 'none'}
Screenshot refs: ${observation.screenshots.map((s) => s.relativePath).join(', ') || 'none'}
Notes:
${observation.notes.join('\n').slice(0, 4_000)}`,
  )
  .join('\n\n')}

Return JSON only:
{
  "status": "pass" | "fail" | "uncertain",
  "reasoning": "short summary",
  "observations": [
    {
      "id": "stable id",
      "targetId": "one checklist target id",
      "status": "pass" | "fail" | "uncertain",
      "summary": "what was observed",
      "details": "optional detail",
      "suggestedFacts": ["optional durable fact suggestions"]
    }
  ]
}

Use status "fail" for concerns, but remember this advisory result must not be treated as a validation blocker.`;
}

function parseReviewerJson(
  raw: string,
): Awaited<ReturnType<AdvisoryBrowserQaReviewer['review']>> | null {
  const cleaned = raw
    .replace(/^```(?:\w+)?\s*\n?/m, '')
    .replace(/\n?\s*```\s*$/m, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (!['pass', 'fail', 'uncertain'].includes(String(record.status))) return null;
    if (typeof record.reasoning !== 'string') return null;
    if (!Array.isArray(record.observations)) return null;

    const observations = record.observations
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => ['pass', 'fail', 'uncertain'].includes(String(item.status)))
      .filter((item) => typeof item.summary === 'string')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : undefined,
        targetId: typeof item.targetId === 'string' ? item.targetId : undefined,
        status: item.status as 'pass' | 'fail' | 'uncertain',
        summary: item.summary as string,
        details: typeof item.details === 'string' ? item.details : undefined,
        suggestedFacts: Array.isArray(item.suggestedFacts)
          ? item.suggestedFacts.filter((fact): fact is string => typeof fact === 'string')
          : undefined,
      }));

    return {
      status: record.status as 'pass' | 'fail' | 'uncertain',
      reasoning: record.reasoning,
      observations,
    };
  } catch {
    return null;
  }
}
