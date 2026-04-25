import type { ScanFinding } from '@autopod/shared';
import type { ScanFile } from '../file-walker.js';
import type { ModelManager, TextClassifier } from '../model-manager.js';
import type { Detector } from './detector.js';

/**
 * Maximum characters per chunk fed to the classifier. DeBERTa-v3 has a
 * 512-token window; ~400 chars is a safe upper bound after tokenization.
 */
const MAX_CHUNK_CHARS = 400;

/**
 * Minimum chars per chunk worth classifying. Short fragments are noise.
 */
const MIN_CHUNK_CHARS = 30;

/**
 * Cap on chunks per file so giant files don't blow the wall-clock budget.
 */
const MAX_CHUNKS_PER_FILE = 50;

/**
 * Default minimum confidence to surface a finding. The scan-engine also
 * applies the per-policy threshold; this is a lower-bound floor.
 */
const FLOOR_CONFIDENCE = 0.6;

export interface InjectionDetectorConfig {
  modelManager: ModelManager;
  /** Override the per-finding floor (defaults to 0.6). */
  floorConfidence?: number;
}

/**
 * Prompt-injection detector backed by an ONNX text-classification model
 * (default: protectai/deberta-v3-base-prompt-injection-v2).
 *
 * Files are split into paragraph-shaped chunks; each chunk above the
 * minimum size is run through the classifier. Chunks labelled INJECTION
 * (or any non-SAFE label) above the confidence floor produce a finding
 * with the chunk's starting line number and the model's score.
 */
export function createInjectionDetector(config: InjectionDetectorConfig): Detector {
  const floor = config.floorConfidence ?? FLOOR_CONFIDENCE;
  let classifier: TextClassifier | null | undefined;

  async function ensureClassifier(): Promise<TextClassifier | null> {
    if (classifier !== undefined) return classifier;
    classifier = await config.modelManager.getInjectionClassifier();
    return classifier;
  }

  return {
    name: 'injection',
    async warmup() {
      await ensureClassifier();
    },
    async scan(file: ScanFile): Promise<ScanFinding[]> {
      const c = await ensureClassifier();
      if (!c) return [];

      const chunks = chunkFile(file.content);
      if (chunks.length === 0) return [];

      const findings: ScanFinding[] = [];
      for (const chunk of chunks) {
        try {
          const out = await c(chunk.text);
          const top = pickInjectionResult(out);
          if (!top) continue;
          if (top.score < floor) continue;
          findings.push({
            detector: 'injection',
            severity: severityFromScore(top.score),
            file: file.path,
            line: chunk.line,
            confidence: top.score,
            ruleId: top.label,
            snippet: truncate(chunk.text, 160),
          });
        } catch {
          // Detector contract: never throw. Skip the chunk on classifier error.
        }
      }
      return findings;
    },
  };
}

interface Chunk {
  text: string;
  line: number;
}

/**
 * Split file content into chunks suitable for the classifier:
 *  - Prefer paragraph (blank-line) boundaries
 *  - Split long paragraphs by line
 *  - Drop chunks shorter than MIN_CHUNK_CHARS
 *  - Cap the total chunk count
 */
export function chunkFile(content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  let buf: string[] = [];
  let bufStart = 1;

  function flushBuf() {
    if (buf.length === 0) return;
    const text = buf.join('\n').trim();
    if (text.length >= MIN_CHUNK_CHARS) {
      // If still too long, hard-split by char count.
      if (text.length <= MAX_CHUNK_CHARS) {
        chunks.push({ text, line: bufStart });
      } else {
        let offset = 0;
        let lineOffset = 0;
        while (offset < text.length && chunks.length < MAX_CHUNKS_PER_FILE) {
          const slice = text.slice(offset, offset + MAX_CHUNK_CHARS);
          if (slice.trim().length >= MIN_CHUNK_CHARS) {
            // Approximate line by counting newlines consumed so far.
            const newlines = text.slice(0, offset).split('\n').length - 1;
            chunks.push({ text: slice.trim(), line: bufStart + newlines });
          }
          offset += MAX_CHUNK_CHARS;
          lineOffset += slice.split('\n').length - 1;
        }
      }
    }
    buf = [];
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
    if (line.trim() === '') {
      flushBuf();
      bufStart = i + 2; // next non-blank line is at i+2 (1-indexed)
      continue;
    }
    if (buf.length === 0) bufStart = i + 1;
    buf.push(line);
    if (buf.join('\n').length > MAX_CHUNK_CHARS) {
      flushBuf();
      bufStart = i + 2;
    }
  }
  flushBuf();
  return chunks.slice(0, MAX_CHUNKS_PER_FILE);
}

function pickInjectionResult(
  out: Array<{ label: string; score: number }>,
): { label: string; score: number } | null {
  // Models in this family commonly return either:
  //   [{label: 'INJECTION', score}, {label: 'SAFE', score}]
  // or top-1 only. Accept any label that's not clearly "safe".
  const top = out[0];
  if (!top) return null;
  const lbl = top.label.toUpperCase();
  if (lbl === 'SAFE' || lbl === 'BENIGN' || lbl === 'LABEL_0') return null;
  return top;
}

function severityFromScore(score: number): ScanFinding['severity'] {
  if (score >= 0.95) return 'critical';
  if (score >= 0.85) return 'high';
  if (score >= 0.7) return 'medium';
  return 'low';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
