import { createHash } from 'node:crypto';
import type { ContentBlock, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import type {
  AdvisoryBrowserQaObservation,
  AdvisoryBrowserQaResult,
  HumanReviewItem,
  ModelProvider,
  ProviderCredentials,
  ScreenshotRef,
  SpecContract,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ScreenshotStore } from '../pods/screenshot-store.js';
import { createProviderAnthropicClient } from '../providers/llm-client.js';
import { runClaudeCli } from '../runtimes/run-claude-cli.js';
import type { HostBrowserRunner } from './host-browser-runner.js';

export const ADVISORY_BROWSER_QA_TARGET_CAP = 5;
const ADVISORY_BROWSER_QA_ACTION_CAP = 5;
const ADVISORY_BROWSER_QA_IMAGE_CAP = 4;
const ADVISORY_BROWSER_QA_RATE_LIMIT_RETRY_BUDGET_MS = 10 * 60_000;
const ADVISORY_BROWSER_QA_RATE_LIMIT_BASE_DELAY_MS = 15_000;
const ADVISORY_BROWSER_QA_RATE_LIMIT_MAX_DELAY_MS = 120_000;

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
  frames?: BrowserFrame[];
  error?: string;
}

interface BrowserFrame {
  label: string;
  url: string;
  title: string;
  notes: string[];
  screenshotPath?: string;
  accessibility?: unknown;
  controls?: BrowserControl[];
  action?: BrowserActionResult;
  error?: string;
}

interface BrowserControl {
  index: number;
  role: string;
  tag: string;
  text: string;
  ariaLabel: string;
  title: string;
  disabled: boolean;
  visible: boolean;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

type AdvisoryBrowserAction =
  | {
      type: 'click';
      controlIndex?: number;
      role?: string;
      name?: string;
      text?: string;
      selector?: string;
      x?: number;
      y?: number;
      reason?: string;
    }
  | {
      type: 'fill';
      selector?: string;
      text?: string;
      value: string;
      reason?: string;
    }
  | {
      type: 'press';
      key: string;
      reason?: string;
    }
  | {
      type: 'wait';
      ms?: number;
      reason?: string;
    }
  | {
      type: 'finish';
      reason?: string;
    };

interface BrowserActionResult {
  status: 'pass' | 'fail' | 'skip';
  action: AdvisoryBrowserAction;
  summary: string;
  error?: string;
}

interface AdvisoryBrowserFrameInput extends Omit<BrowserFrame, 'screenshotPath'> {
  screenshots: ScreenshotRef[];
  screenshotBase64?: string;
  imageLabel?: string;
}

interface AdvisoryBrowserObservationInput
  extends Omit<BrowserObservation, 'screenshotPath' | 'frames'> {
  screenshots: ScreenshotRef[];
  screenshotBase64?: string;
  frames: AdvisoryBrowserFrameInput[];
}

export interface AdvisoryBrowserQaReviewInput {
  task: string;
  baseUrl: string;
  targets: AdvisoryChecklistTarget[];
  browserObservations: AdvisoryBrowserObservationInput[];
}

export interface AdvisoryBrowserQaReviewer {
  planActions?(input: AdvisoryBrowserQaReviewInput): Promise<
    Array<{
      targetId: string;
      actions: AdvisoryBrowserAction[];
    }>
  >;
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
  reviewerProvider?: ModelProvider | null;
  reviewerProviderCredentials?: ProviderCredentials | null;
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
    const initialScript = buildBrowserScript({
      baseUrl: options.baseUrl,
      screenshotDir,
      targets,
    });
    const initialRun = await options.hostBrowserRunner.runScript(initialScript, {
      podId: options.podId,
      timeout: options.timeoutMs ?? 120_000,
    });
    let observations = parseBrowserObservations(initialRun.stdout);
    if (initialRun.exitCode !== 0 && observations.length === 0) {
      return {
        status: 'uncertain',
        reasoning: `Advisory browser QA script failed: ${initialRun.stderr.slice(0, 1_000)}`,
        durationMs: Date.now() - start,
        observations: [],
        screenshots: [],
      };
    }

    const reviewer =
      options.reviewer ??
      createProviderAwareAdvisoryReviewer({
        model: options.reviewerModel,
        provider: options.reviewerProvider,
        credentials: options.reviewerProviderCredentials,
        logger: log,
      });

    const initialScreenshotCollection = await collectAdvisoryScreenshots(
      observations,
      options.hostBrowserRunner,
      options.podId,
      { persist: false },
      log,
    );
    const initialReviewInput = buildReviewInput({
      task: options.task,
      baseUrl: options.baseUrl,
      targets,
      observations,
      screenshots: initialScreenshotCollection,
    });
    const heuristicPlan = buildHeuristicActionPlan(initialReviewInput);
    const plannedActions =
      heuristicPlan.size > 0 ? [] : await safePlanActions(reviewer, initialReviewInput, log);
    const actionPlan = mergeActionPlans(plannedActions, heuristicPlan);
    if (actionPlan.size > 0) {
      const actionScript = buildBrowserScript({
        baseUrl: options.baseUrl,
        screenshotDir,
        targets,
        actionsByTarget: Object.fromEntries(actionPlan),
      });
      const actionRun = await options.hostBrowserRunner.runScript(actionScript, {
        podId: options.podId,
        timeout: options.timeoutMs ?? 120_000,
      });
      const actionObservations = parseBrowserObservations(actionRun.stdout);
      if (actionObservations.length > 0) {
        observations = actionObservations;
      } else if (actionRun.exitCode !== 0) {
        log?.warn(
          { stderr: actionRun.stderr.slice(0, 1_000) },
          'advisory browser QA action script failed; reviewing initial observations',
        );
      }
    }

    const screenshotCollection = await collectAdvisoryScreenshots(
      observations,
      options.hostBrowserRunner,
      options.podId,
      { persist: true, screenshotStore: options.screenshotStore },
      log,
    );
    const reviewInput = buildReviewInput({
      task: options.task,
      baseUrl: options.baseUrl,
      targets,
      observations,
      screenshots: screenshotCollection,
    });
    const review = await reviewer.review({
      task: reviewInput.task,
      baseUrl: reviewInput.baseUrl,
      targets: reviewInput.targets,
      browserObservations: reviewInput.browserObservations,
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
          screenshots: targetId ? (screenshotCollection.byTarget.get(targetId) ?? []) : [],
          suggestedFacts: observation.suggestedFacts,
        };
      },
    );
    const screenshots = [
      ...new Map(
        [...screenshotCollection.byTarget.values()].flat().map((ref) => [ref.relativePath, ref]),
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
  actionsByTarget?: Record<string, AdvisoryBrowserAction[]>;
}): string {
  return `
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = ${JSON.stringify(input.baseUrl)};
const screenshotDir = ${JSON.stringify(input.screenshotDir)};
const targets = ${JSON.stringify(input.targets)};
const actionsByTarget = ${JSON.stringify(input.actionsByTarget ?? {})};

await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80) || 'target';
}

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/\\s+/g, ' ').trim().slice(0, max);
}

function getImplicitRole(el, tag) {
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    if (['checkbox', 'radio', 'slider', 'spinbutton'].includes(type)) return type;
    return 'textbox';
  }
  return tag || 'unknown';
}

async function collectControls(page) {
  try {
    return await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          'button,[role="button"],a[href],input,select,textarea,[aria-label],[title]',
        ),
      );
      return nodes.slice(0, 100).map((el, index) => {
        const tag = el.tagName.toLowerCase();
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0;
        const role =
          el.getAttribute('role') ||
          (tag === 'button'
            ? 'button'
            : tag === 'a'
              ? 'link'
              : tag === 'select'
                ? 'combobox'
                : tag === 'textarea'
                  ? 'textbox'
                  : tag === 'input'
                    ? 'textbox'
                    : tag);
        return {
          index,
          role,
          tag,
          text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
          ariaLabel: String(el.getAttribute('aria-label') || '').slice(0, 300),
          title: String(el.getAttribute('title') || '').slice(0, 300),
          disabled:
            el.hasAttribute('disabled') ||
            el.getAttribute('aria-disabled') === 'true',
          visible,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
    });
  } catch (err) {
    return [
      {
        index: 0,
        role: 'error',
        tag: 'error',
        text: err instanceof Error ? err.message : String(err),
        ariaLabel: '',
        title: '',
        disabled: true,
        visible: false,
      },
    ];
  }
}

async function collectAccessibility(page) {
  try {
    if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
      return await page.accessibility.snapshot({ interestingOnly: true });
    }
    return { unavailable: 'Playwright accessibility snapshot API is unavailable' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function captureFrame(page, targetId, frameIndex, label, action) {
  const screenshotPath = join(
    screenshotDir,
    safeFilePart(targetId) + '-' + String(frameIndex).padStart(2, '0') + '.png',
  );
  const notes = [];
  let bodyText = '';
  try {
    bodyText = await page.locator('body').innerText({ timeout: 5000 });
  } catch (err) {
    bodyText = 'Could not read body text: ' + (err instanceof Error ? err.message : String(err));
  }
  notes.push(bodyText.slice(0, 3000));
  const controls = await collectControls(page);
  const accessibility = await collectAccessibility(page);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return {
    label,
    url: page.url(),
    title: await page.title().catch(() => ''),
    notes,
    screenshotPath,
    accessibility,
    controls,
    action,
  };
}

async function performAction(page, action, controls) {
  try {
    if (!action || action.type === 'finish') {
      return { status: 'skip', action, summary: action?.reason || 'No action requested' };
    }
    if (action.type === 'wait') {
      await page.waitForTimeout(Math.max(0, Math.min(Number(action.ms || 500), 3000)));
      return { status: 'pass', action, summary: 'Waited' };
    }
    if (action.type === 'press') {
      await page.keyboard.press(String(action.key || 'Escape'));
      return { status: 'pass', action, summary: 'Pressed ' + String(action.key || 'Escape') };
    }
    if (action.type === 'fill') {
      if (action.selector) {
        await page.locator(action.selector).first().fill(String(action.value || ''));
      } else if (action.text) {
        await page.getByLabel(new RegExp(String(action.text), 'i')).first().fill(String(action.value || ''));
      } else {
        throw new Error('fill action requires selector or text');
      }
      return { status: 'pass', action, summary: 'Filled control' };
    }
    if (action.type === 'click') {
      if (Number.isInteger(action.controlIndex)) {
        const control = controls[Number(action.controlIndex)];
        if (!control?.rect) throw new Error('controlIndex did not resolve to a visible control');
        await page.mouse.click(
          control.rect.x + control.rect.width / 2,
          control.rect.y + control.rect.height / 2,
        );
      } else if (action.selector) {
        await page.locator(action.selector).first().click();
      } else if (action.role && action.name) {
        await page.getByRole(action.role, { name: new RegExp(String(action.name), 'i') }).first().click();
      } else if (action.text) {
        await page.getByText(String(action.text), { exact: false }).first().click();
      } else if (Number.isFinite(action.x) && Number.isFinite(action.y)) {
        await page.mouse.click(Number(action.x), Number(action.y));
      } else {
        throw new Error('click action requires controlIndex, selector, role/name, text, or coordinates');
      }
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(250);
      return { status: 'pass', action, summary: action.reason || 'Clicked control' };
    }
    return { status: 'skip', action, summary: 'Unsupported action type' };
  } catch (err) {
    return {
      status: 'fail',
      action,
      summary: 'Action failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

try {
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const page = await browser.newPage({ locale: 'en-US' });
    const notes = [];
    const frames = [];
    try {
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      notes.push('Reached ' + page.url());
      frames.push(await captureFrame(page, target.id, 0, 'initial', undefined));
      const actions = Array.isArray(actionsByTarget[target.id])
        ? actionsByTarget[target.id].slice(0, ${ADVISORY_BROWSER_QA_ACTION_CAP})
        : [];
      for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        const previous = frames[frames.length - 1];
        const actionResult = await performAction(page, actions[actionIndex], previous?.controls || []);
        frames.push(
          await captureFrame(
            page,
            target.id,
            actionIndex + 1,
            'after-action-' + (actionIndex + 1),
            actionResult,
          ),
        );
        if (actions[actionIndex]?.type === 'finish') break;
      }
      const lastFrame = frames[frames.length - 1];
      results.push({
        targetId: target.id,
        url: lastFrame?.url || page.url(),
        title: lastFrame?.title || (await page.title()),
        notes,
        frames,
        screenshotPath: frames[0]?.screenshotPath,
      });
    } catch (err) {
      try {
        frames.push(await captureFrame(page, target.id, frames.length, 'error', undefined));
      } catch {}
      results.push({
        targetId: target.id,
        url: page.url(),
        title: await page.title().catch(() => ''),
        notes,
        frames,
        screenshotPath: frames[0]?.screenshotPath,
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
      frames: parseBrowserFrames(item.frames),
      error: typeof item.error === 'string' ? item.error : undefined,
    }))
    .filter((item) => item.targetId);
}

function parseBrowserFrames(value: unknown): BrowserFrame[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item, index) => ({
      label: typeof item.label === 'string' ? item.label : `frame-${index}`,
      url: typeof item.url === 'string' ? item.url : '',
      title: typeof item.title === 'string' ? item.title : '',
      notes: Array.isArray(item.notes)
        ? item.notes.filter((note): note is string => typeof note === 'string')
        : [],
      screenshotPath: typeof item.screenshotPath === 'string' ? item.screenshotPath : undefined,
      accessibility: item.accessibility,
      controls: parseBrowserControls(item.controls),
      action: parseBrowserActionResult(item.action),
      error: typeof item.error === 'string' ? item.error : undefined,
    }));
}

function parseBrowserControls(value: unknown): BrowserControl[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item, index) => ({
      index: typeof item.index === 'number' ? item.index : index,
      role: typeof item.role === 'string' ? item.role : '',
      tag: typeof item.tag === 'string' ? item.tag : '',
      text: typeof item.text === 'string' ? item.text : '',
      ariaLabel: typeof item.ariaLabel === 'string' ? item.ariaLabel : '',
      title: typeof item.title === 'string' ? item.title : '',
      disabled: item.disabled === true,
      visible: item.visible !== false,
      rect: parseRect(item.rect),
    }));
}

function parseRect(value: unknown): BrowserControl['rect'] {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width, height };
}

function parseBrowserActionResult(value: unknown): BrowserActionResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const status = String(record.status);
  if (!['pass', 'fail', 'skip'].includes(status)) return undefined;
  return {
    status: status as BrowserActionResult['status'],
    action: sanitizeAction(record.action),
    summary: typeof record.summary === 'string' ? record.summary : '',
    error: typeof record.error === 'string' ? record.error : undefined,
  };
}

function observationFrames(observation: BrowserObservation): BrowserFrame[] {
  if (observation.frames && observation.frames.length > 0) return observation.frames;
  return [
    {
      label: 'initial',
      url: observation.url,
      title: observation.title,
      notes: observation.notes,
      screenshotPath: observation.screenshotPath,
      error: observation.error,
    },
  ];
}

interface CollectedAdvisoryScreenshots {
  byTarget: Map<string, ScreenshotRef[]>;
  byFrame: Map<string, { ref?: ScreenshotRef; base64: string }>;
}

async function collectAdvisoryScreenshots(
  observations: BrowserObservation[],
  hostBrowserRunner: HostBrowserRunner,
  podId: string,
  opts: { persist: false } | { persist: true; screenshotStore: ScreenshotStore },
  log?: Logger,
): Promise<CollectedAdvisoryScreenshots> {
  const byTarget = new Map<string, ScreenshotRef[]>();
  const byFrame = new Map<string, { ref?: ScreenshotRef; base64: string }>();
  const persistedByDigest = new Map<string, ScreenshotRef>();
  let screenshotIndex = 0;

  for (const observation of observations) {
    const frames = observationFrames(observation);
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
      const frame = frames[frameIndex];
      if (!frame?.screenshotPath) continue;

      try {
        const base64 = await hostBrowserRunner.readScreenshot(frame.screenshotPath);
        let ref: ScreenshotRef | undefined;
        if (opts.persist) {
          const digest = screenshotDigest(base64);
          ref = persistedByDigest.get(digest);
          if (!ref) {
            ref = await opts.screenshotStore.write(
              podId,
              'advisory',
              `advisory-${screenshotIndex}.png`,
              Buffer.from(base64, 'base64'),
            );
            persistedByDigest.set(digest, ref);
            screenshotIndex += 1;
          }
          byTarget.set(observation.targetId, [...(byTarget.get(observation.targetId) ?? []), ref]);
        }
        byFrame.set(frameKey(observation.targetId, frameIndex), { ref, base64 });
      } catch (err) {
        log?.warn(
          { err, targetId: observation.targetId, frame: frame.label },
          'failed to collect advisory screenshot',
        );
      }
    }
  }

  return { byTarget, byFrame };
}

function screenshotDigest(base64: string): string {
  return createHash('sha256').update(base64).digest('hex');
}

function frameKey(targetId: string, frameIndex: number): string {
  return `${targetId}#${frameIndex}`;
}

function buildReviewInput(input: {
  task: string;
  baseUrl: string;
  targets: AdvisoryChecklistTarget[];
  observations: BrowserObservation[];
  screenshots: CollectedAdvisoryScreenshots;
}): AdvisoryBrowserQaReviewInput {
  let imageCount = 0;
  const seenImageBytes = new Set<string>();
  return {
    task: input.task,
    baseUrl: input.baseUrl,
    targets: input.targets,
    browserObservations: input.observations.map((observation) => {
      const frames = observationFrames(observation).map((frame, frameIndex) => {
        const collected = input.screenshots.byFrame.get(frameKey(observation.targetId, frameIndex));
        const shouldAttachImage =
          collected?.base64 &&
          !seenImageBytes.has(collected.base64) &&
          imageCount < ADVISORY_BROWSER_QA_IMAGE_CAP;
        if (shouldAttachImage) seenImageBytes.add(collected.base64);
        const imageLabel = shouldAttachImage ? `Image ${++imageCount}` : undefined;
        return {
          label: frame.label,
          url: frame.url,
          title: frame.title,
          notes: frame.notes,
          accessibility: frame.accessibility,
          controls: frame.controls,
          action: frame.action,
          error: frame.error,
          screenshots: collected?.ref ? [collected.ref] : [],
          screenshotBase64: collected?.base64,
          imageLabel,
        };
      });
      return {
        targetId: observation.targetId,
        url: observation.url,
        title: observation.title,
        notes: observation.notes,
        error: observation.error,
        screenshots: input.screenshots.byTarget.get(observation.targetId) ?? [],
        screenshotBase64: frames.find((frame) => frame.screenshotBase64)?.screenshotBase64,
        frames,
      };
    }),
  };
}

async function safePlanActions(
  reviewer: AdvisoryBrowserQaReviewer,
  input: AdvisoryBrowserQaReviewInput,
  log?: Logger,
): Promise<Array<{ targetId: string; actions: AdvisoryBrowserAction[] }>> {
  if (!reviewer.planActions) return [];
  try {
    return await reviewer.planActions(input);
  } catch (err) {
    log?.warn({ err }, 'advisory browser QA action planning failed');
    return [];
  }
}

function mergeActionPlans(
  planned: Array<{ targetId: string; actions: AdvisoryBrowserAction[] }>,
  heuristic: Map<string, AdvisoryBrowserAction[]>,
): Map<string, AdvisoryBrowserAction[]> {
  const merged = new Map<string, AdvisoryBrowserAction[]>();
  for (const item of planned) {
    const actions = item.actions.map(sanitizeAction).slice(0, ADVISORY_BROWSER_QA_ACTION_CAP);
    if (item.targetId && actions.length > 0) merged.set(item.targetId, actions);
  }
  for (const [targetId, actions] of heuristic) {
    if (!merged.has(targetId))
      merged.set(targetId, actions.slice(0, ADVISORY_BROWSER_QA_ACTION_CAP));
  }
  return merged;
}

function buildHeuristicActionPlan(
  input: AdvisoryBrowserQaReviewInput,
): Map<string, AdvisoryBrowserAction[]> {
  const actions = new Map<string, AdvisoryBrowserAction[]>();
  const targetById = new Map(input.targets.map((target) => [target.id, target]));
  for (const observation of input.browserObservations) {
    const target = targetById.get(observation.targetId);
    const text = `${input.task}\n${target?.prompt ?? ''}`.toLowerCase();
    if (!/(help|how.to.use|modal|dialog|toolbar)/i.test(text)) continue;
    const initial = observation.frames[0];
    const helpControl = initial?.controls?.find((control) => {
      if (!control.visible || control.disabled) return false;
      const label = `${control.ariaLabel} ${control.title} ${control.text}`.trim();
      return control.role === 'button' && /(^|\s)(help|\?)(\s|$)/i.test(label);
    });
    if (helpControl) {
      actions.set(observation.targetId, [
        {
          type: 'click',
          controlIndex: helpControl.index,
          reason: 'Open the visible Help control to verify the modal/dialog scenario.',
        },
      ]);
    }
  }
  return actions;
}

function createProviderAwareAdvisoryReviewer(input: {
  model: string | undefined;
  provider?: ModelProvider | null;
  credentials?: ProviderCredentials | null;
  logger?: Logger;
}): AdvisoryBrowserQaReviewer {
  return {
    async planActions(reviewInput) {
      if (!input.model) return [];
      if (input.provider === 'openai' || input.provider === 'copilot') return [];
      const prompt = buildActionPlannerPrompt(reviewInput);
      try {
        const stdout = await callAnthropicReviewer({
          model: input.model,
          provider: input.provider,
          credentials: input.credentials,
          prompt,
          input: reviewInput,
          logger: input.logger,
          maxTokens: 2_000,
          includeImages: false,
        });
        return parseActionPlanJson(stdout);
      } catch (err) {
        input.logger?.warn({ err }, 'advisory browser QA action planner failed');
        return [];
      }
    },
    async review(reviewInput) {
      if (!input.model) {
        return {
          status: 'uncertain',
          reasoning: 'No reviewer model configured for advisory browser QA',
          observations: [],
        };
      }

      if (input.provider === 'openai' || input.provider === 'copilot') {
        return {
          status: 'uncertain',
          reasoning: `Reviewer provider ${input.provider} does not yet support screenshot image input for advisory browser QA.`,
          observations: [],
        };
      }

      const prompt = buildReviewerPrompt(reviewInput, { includeImages: true });
      try {
        const stdout = await callAnthropicReviewer({
          model: input.model,
          provider: input.provider,
          credentials: input.credentials,
          prompt,
          input: reviewInput,
          logger: input.logger,
          maxTokens: 2_000,
        });
        const parsed = parseReviewerJson(stdout);
        if (parsed) return parsed;
        return {
          status: 'uncertain',
          reasoning: 'Advisory browser QA reviewer returned malformed JSON',
          observations: [],
        };
      } catch (err) {
        if (isRateLimitError(err)) {
          input.logger?.warn(
            { err },
            'advisory browser QA image review rate-limited; trying structured-evidence fallback',
          );
          try {
            const fallbackStdout = await callAnthropicReviewer({
              model: input.model,
              provider: input.provider,
              credentials: input.credentials,
              prompt: buildReviewerPrompt(reviewInput, { includeImages: false }),
              input: reviewInput,
              logger: input.logger,
              maxTokens: 1_500,
              includeImages: false,
            });
            const fallbackParsed = parseReviewerJson(fallbackStdout);
            if (fallbackParsed) {
              return {
                ...fallbackParsed,
                reasoning: `Image review was rate-limited; reviewed structured browser evidence instead. ${fallbackParsed.reasoning}`,
              };
            }
          } catch (fallbackErr) {
            input.logger?.warn(
              { err: fallbackErr },
              'advisory browser QA structured-evidence fallback failed',
            );
          }
          return {
            status: 'uncertain',
            reasoning:
              'Advisory browser QA captured screenshots, but the reviewer provider rate-limited the visual review. Evidence is available for manual inspection; retry advisory QA later if an AI visual opinion is needed.',
            observations: [],
          };
        }
        const detail = formatReviewerError(err);
        return {
          status: 'uncertain',
          reasoning: `Advisory browser QA reviewer failed: ${detail}`,
          observations: [],
        };
      }
    },
  };
}

async function callAnthropicReviewer(input: {
  model: string;
  provider?: ModelProvider | null;
  credentials?: ProviderCredentials | null;
  prompt: string;
  input: AdvisoryBrowserQaReviewInput;
  logger?: Logger;
  maxTokens: number;
  includeImages?: boolean;
}): Promise<string> {
  const llm = await createProviderAnthropicClient(
    {
      provider: input.provider,
      credentials: input.credentials,
      model: input.model,
      profileName: 'advisory-browser-qa',
    },
    input.logger ?? noopLogger,
  );
  if (!llm.ok) {
    if (!input.provider || input.provider === 'anthropic') {
      const { stdout } = await runClaudeCli({
        model: input.model,
        input: `${input.prompt}\n\nNote: screenshot images could not be attached because no daemon-callable Anthropic API credentials were available. Use the structured browser observations only.`,
        timeout: 120_000,
      });
      return stdout;
    }
    throw new Error(`Reviewer provider unavailable: ${llm.reason}`);
  }
  const response = await retryRateLimited(
    () =>
      llm.client.messages.create(
        {
          model: llm.model,
          max_tokens: input.maxTokens,
          messages: [
            {
              role: 'user',
              content:
                input.includeImages === false
                  ? [{ type: 'text', text: input.prompt }]
                  : buildAnthropicContent(input.prompt, input.input),
            },
          ],
        },
        { timeout: 120_000 },
      ),
    input.logger,
  );
  return response.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

async function retryRateLimited<T>(operation: () => Promise<T>, log?: Logger): Promise<T> {
  const deadline = Date.now() + ADVISORY_BROWSER_QA_RATE_LIMIT_RETRY_BUDGET_MS;
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw err;
      const fallbackDelayMs = fallbackRateLimitDelayMs(attempt);
      const delayMs = retryDelayMs(err, fallbackDelayMs);
      log?.warn(
        { err, attempt: attempt + 1, delayMs, retryBudgetRemainingMs: remainingMs },
        'advisory browser QA reviewer rate-limited; retrying after backoff',
      );
      attempt += 1;
      await sleep(Math.min(delayMs, remainingMs));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fallbackRateLimitDelayMs(attempt: number): number {
  return Math.min(
    ADVISORY_BROWSER_QA_RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt,
    ADVISORY_BROWSER_QA_RATE_LIMIT_MAX_DELAY_MS,
  );
}

function retryDelayMs(err: unknown, fallbackMs: number): number {
  const retryAfter = headerValue(err, 'retry-after');
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.max(
      500,
      Math.min(ADVISORY_BROWSER_QA_RATE_LIMIT_MAX_DELAY_MS, retryAfterSeconds * 1_000),
    );
  }
  if (retryAfter) {
    const retryAfterDate = Date.parse(retryAfter);
    if (Number.isFinite(retryAfterDate)) {
      return Math.max(
        500,
        Math.min(ADVISORY_BROWSER_QA_RATE_LIMIT_MAX_DELAY_MS, retryAfterDate - Date.now()),
      );
    }
  }
  return fallbackMs;
}

function headerValue(err: unknown, name: string): string | undefined {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const headers = record.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const getter = (headers as { get?: (key: string) => string | null | undefined }).get;
  if (typeof getter === 'function') return getter.call(headers, name) ?? undefined;
  const entry = Object.entries(headers as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function formatReviewerError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRateLimitError(err: unknown): boolean {
  const record = err && typeof err === 'object' ? (err as Record<string, unknown>) : {};
  const status = record.status;
  const type = record.type;
  const error = record.error;
  const text = formatReviewerError(err);
  if (status === 429 || type === 'rate_limit_error') return true;
  if (error && typeof error === 'object') {
    const nestedType = (error as Record<string, unknown>).type;
    if (nestedType === 'rate_limit_error') return true;
  }
  return /\b429\b|rate[_ -]?limit/i.test(text);
}

const noopLogger = {
  warn() {},
  info() {},
  debug() {},
  error() {},
  child() {
    return noopLogger;
  },
} as unknown as Logger;

function buildAnthropicContent(
  prompt: string,
  input: AdvisoryBrowserQaReviewInput,
): ContentBlockParam[] {
  const content: ContentBlockParam[] = [{ type: 'text', text: prompt }];
  let imageCount = 0;
  for (const observation of input.browserObservations) {
    for (const frame of observation.frames) {
      if (!frame.imageLabel || !frame.screenshotBase64) continue;
      if (imageCount >= ADVISORY_BROWSER_QA_IMAGE_CAP) continue;
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: frame.screenshotBase64,
        },
      });
      imageCount += 1;
    }
  }
  return content;
}

function buildActionPlannerPrompt(input: AdvisoryBrowserQaReviewInput): string {
  return `You are steering a real browser for advisory QA. The browser is open on the target app.

Your job now is only to choose a small, safe action plan that helps verify the checklist. Prefer clicking visible controls by controlIndex from the observed controls. Do not invent selectors.

${describeAdvisoryInput(input)}

Return JSON only:
{
  "actions": [
    {
      "targetId": "one checklist target id",
      "actions": [
        { "type": "click", "controlIndex": 0, "reason": "why this helps" }
      ]
    }
  ]
}

Allowed action types:
- click: { "type": "click", "controlIndex": number, "reason": string }
- click by role/name only if no controlIndex exists
- press: { "type": "press", "key": "Escape" }
- wait: { "type": "wait", "ms": 500 }
- finish: { "type": "finish" }

Use at most ${ADVISORY_BROWSER_QA_ACTION_CAP} actions per target. If no action is needed, return { "actions": [] }.`;
}

function buildReviewerPrompt(
  input: AdvisoryBrowserQaReviewInput,
  options: { includeImages: boolean },
): string {
  const evidenceInstruction = options.includeImages
    ? 'You receive screenshot images as content blocks plus structured page observations. Use the images to verify visual/icon-only UI. Use the accessibility and controls metadata to distinguish "visible but inaccessible" from "absent".'
    : 'You do not receive screenshot images in this fallback review. Use the structured page observations, body text, accessibility snapshots, visible controls, and recorded action results. Use status "uncertain" when visual proof truly requires pixels.';
  return `You are doing advisory browser QA for a running web app. This is non-blocking evidence only.

${evidenceInstruction}

${describeAdvisoryInput(input)}

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

function describeAdvisoryInput(input: AdvisoryBrowserQaReviewInput): string {
  return `Task:
${input.task}

Base URL:
${input.baseUrl}

Checklist targets:
${input.targets.map((target, index) => `${index + 1}. ${target.id}\n${target.prompt}`).join('\n\n')}

Browser observations:
${input.browserObservations
  .map((observation, index) => describeObservation(observation, index))
  .join('\n\n')}`;
}

function describeObservation(
  observation: AdvisoryBrowserObservationInput,
  observationIndex: number,
): string {
  const frameText = observation.frames
    .map((frame, frameIndex) => {
      const controls = (frame.controls ?? [])
        .filter((control) => control.visible)
        .slice(0, 40)
        .map((control) => ({
          index: control.index,
          role: control.role,
          tag: control.tag,
          text: control.text,
          ariaLabel: control.ariaLabel,
          title: control.title,
          disabled: control.disabled,
          rect: control.rect,
        }));
      return `  Frame ${frameIndex + 1}: ${frame.label}${frame.imageLabel ? ` (${frame.imageLabel})` : ''}
  URL: ${frame.url}
  Title: ${frame.title}
  Action: ${frame.action ? JSON.stringify(frame.action).slice(0, 800) : 'none'}
  Error: ${frame.error ?? 'none'}
  Screenshot refs: ${frame.screenshots.map((s) => s.relativePath).join(', ') || 'none'}
  Visible controls: ${JSON.stringify(controls).slice(0, 5_000)}
  Accessibility snapshot: ${stringifyForPrompt(frame.accessibility, 5_000)}
  Notes:
  ${frame.notes.join('\n').slice(0, 2_000)}`;
    })
    .join('\n');
  return `${observationIndex + 1}. ${observation.targetId}
URL: ${observation.url}
Title: ${observation.title}
Error: ${observation.error ?? 'none'}
${frameText}`;
}

function stringifyForPrompt(value: unknown, max: number): string {
  if (value === undefined) return 'none';
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

function parseActionPlanJson(
  raw: string,
): Array<{ targetId: string; actions: AdvisoryBrowserAction[] }> {
  const cleaned = raw
    .replace(/^```(?:\w+)?\s*\n?/m, '')
    .replace(/\n?\s*```\s*$/m, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const actions = (parsed as Record<string, unknown>).actions;
    if (!Array.isArray(actions)) return [];
    return actions
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => ({
        targetId: typeof item.targetId === 'string' ? item.targetId : '',
        actions: Array.isArray(item.actions)
          ? item.actions.map(sanitizeAction).slice(0, ADVISORY_BROWSER_QA_ACTION_CAP)
          : [],
      }))
      .filter((item) => item.targetId && item.actions.length > 0);
  } catch {
    return [];
  }
}

function sanitizeAction(value: unknown): AdvisoryBrowserAction {
  if (!value || typeof value !== 'object') return { type: 'finish' };
  const record = value as Record<string, unknown>;
  const type = String(record.type);
  const reason = typeof record.reason === 'string' ? record.reason : undefined;
  if (type === 'click') {
    return {
      type: 'click',
      controlIndex:
        typeof record.controlIndex === 'number' && Number.isInteger(record.controlIndex)
          ? record.controlIndex
          : undefined,
      role: typeof record.role === 'string' ? record.role : undefined,
      name: typeof record.name === 'string' ? record.name : undefined,
      text: typeof record.text === 'string' ? record.text : undefined,
      selector: typeof record.selector === 'string' ? record.selector : undefined,
      x: typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : undefined,
      y: typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : undefined,
      reason,
    };
  }
  if (type === 'fill') {
    return {
      type: 'fill',
      selector: typeof record.selector === 'string' ? record.selector : undefined,
      text: typeof record.text === 'string' ? record.text : undefined,
      value: typeof record.value === 'string' ? record.value : '',
      reason,
    };
  }
  if (type === 'press') {
    return { type: 'press', key: typeof record.key === 'string' ? record.key : 'Escape', reason };
  }
  if (type === 'wait') {
    return { type: 'wait', ms: typeof record.ms === 'number' ? record.ms : undefined, reason };
  }
  return { type: 'finish', reason };
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
