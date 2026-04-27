import type { ScanFinding } from '@autopod/shared';
import type { ScanFile } from '../file-walker.js';
import type { ModelManager, TokenClassificationItem, TokenClassifier } from '../model-manager.js';
import type { Detector } from './detector.js';

/**
 * Maximum characters per chunk fed to the NER pipeline. piiranha-v1 is
 * DeBERTa-based with a 512-token window; ~400 chars stays comfortably inside it.
 */
const MAX_CHUNK_CHARS = 400;

/** Minimum chars per chunk worth running NER on. */
const MIN_CHUNK_CHARS = 30;

/** Cap on chunks per file. Bounds runtime on giant files. */
const MAX_CHUNKS_PER_FILE = 50;

/** Default minimum confidence to surface a finding. */
const FLOOR_CONFIDENCE = 0.6;

/** Token labels we treat as "no PII". piiranha emits `O` for non-entity tokens. */
const NON_PII_LABELS = new Set(['O', 'LABEL_0']);

export interface PiiDetectorConfig {
  modelManager: ModelManager;
  /** Override the per-finding floor confidence. */
  floorConfidence?: number;
}

/**
 * PII detector backed by an ONNX token-classification model
 * (default: iiiorg/piiranha-v1-detect-personal-information).
 *
 * Each file is paragraph-chunked; the NER pipeline runs on each chunk and
 * emits per-token labels. Consecutive same-label tokens are merged into a
 * single span and reported as a finding with the entity label as the rule id.
 */
export function createPiiDetector(config: PiiDetectorConfig): Detector {
  const floor = config.floorConfidence ?? FLOOR_CONFIDENCE;
  let classifier: TokenClassifier | null | undefined;

  async function ensureClassifier(): Promise<TokenClassifier | null> {
    if (classifier !== undefined) return classifier;
    classifier = await config.modelManager.getPiiClassifier();
    return classifier;
  }

  return {
    name: 'pii',
    async warmup() {
      await ensureClassifier();
    },
    async scan(file: ScanFile): Promise<ScanFinding[]> {
      const c = await ensureClassifier();
      if (!c) return [];

      const chunks = chunkText(file.content);
      if (chunks.length === 0) return [];

      const findings: ScanFinding[] = [];
      for (const chunk of chunks) {
        try {
          const tokens = await c(chunk.text);
          const spans = mergeSpans(tokens, floor);
          for (const span of spans) {
            // Prefer slicing the original chunk text by start/end offsets:
            // it preserves the literal substring (correct casing, internal
            // punctuation, no wordpiece artifacts like "Amp hi theatre kw y")
            // and works for both BERT-style and SentencePiece tokenizers.
            const snippet =
              span.start !== undefined && span.end !== undefined
                ? chunk.text.slice(span.start, span.end)
                : span.word;
            findings.push({
              detector: 'pii',
              severity: severityFromScore(span.score),
              file: file.path,
              line: chunk.line,
              ruleId: span.label,
              confidence: span.score,
              snippet: truncate(snippet, 80),
            });
          }
        } catch {
          // Detector contract: never throw. Skip the chunk on classifier error.
        }
      }
      return findings;
    },
  };
}

interface SpanFinding {
  label: string;
  word: string;
  score: number;
  start?: number;
  end?: number;
}

interface InProgressSpan {
  label: string;
  parts: string[];
  scores: number[];
  start?: number;
  end?: number;
}

/**
 * Merge consecutive same-label tokens into a single span. Floor is applied
 * to the *aggregate* span score (mean across tokens), not per-token: the
 * underlying model assigns high confidence to the first wordpiece of a name
 * and lower confidence to subsequent wordpieces. A per-token floor would
 * truncate "Esben" → "Es" and drop "Wiberg" entirely. Filtering at the span
 * level keeps the full entity intact while still rejecting weak guesses.
 *
 * Tokens whose top label is `O`/non-PII or empty break any in-progress span.
 */
export function mergeSpans(tokens: TokenClassificationItem[], floor: number): SpanFinding[] {
  const out: SpanFinding[] = [];
  let current: InProgressSpan | null = null;

  function commit() {
    if (!current) return;
    const meanScore = current.scores.reduce((a, b) => a + b, 0) / current.scores.length;
    if (meanScore >= floor) {
      out.push({
        label: current.label,
        word: current.parts.join(''),
        score: meanScore,
        start: current.start,
        end: current.end,
      });
    }
    current = null;
  }

  for (const tok of tokens) {
    const rawLabel = tok.entity ?? '';
    const label = stripBio(rawLabel);
    const isPii = !NON_PII_LABELS.has(label) && rawLabel !== '';
    if (!isPii) {
      commit();
      continue;
    }
    const word = tok.word.startsWith('##') ? tok.word.slice(2) : tok.word;
    // Detect contiguous wordpieces via offsets — works for BERT (##) and
    // SentencePiece tokenizers alike. Falls back to the ## marker when
    // offsets are missing.
    const isContinuation =
      current &&
      current.label === label &&
      ((tok.start !== undefined && current.end === tok.start) || tok.word.startsWith('##'));
    if (current && current.label === label) {
      const piece = isContinuation ? word : ` ${word}`;
      current.parts.push(piece);
      current.scores.push(tok.score);
      if (tok.end !== undefined) current.end = tok.end;
    } else {
      commit();
      current = {
        label,
        parts: [word],
        scores: [tok.score],
        start: tok.start,
        end: tok.end,
      };
    }
  }
  commit();
  return out;
}

interface Chunk {
  text: string;
  line: number;
}

/**
 * Chunk by blank lines, then by char count. Mirrors the injection detector's
 * chunking but kept separate since the line-tracking caller may differ.
 */
export function chunkText(content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  let buf: string[] = [];
  let bufStart = 1;

  function flushBuf() {
    if (buf.length === 0) return;
    const text = buf.join('\n').trim();
    if (text.length >= MIN_CHUNK_CHARS) {
      if (text.length <= MAX_CHUNK_CHARS) {
        chunks.push({ text, line: bufStart });
      } else {
        let offset = 0;
        while (offset < text.length && chunks.length < MAX_CHUNKS_PER_FILE) {
          const slice = text.slice(offset, offset + MAX_CHUNK_CHARS);
          if (slice.trim().length >= MIN_CHUNK_CHARS) {
            const newlines = text.slice(0, offset).split('\n').length - 1;
            chunks.push({ text: slice.trim(), line: bufStart + newlines });
          }
          offset += MAX_CHUNK_CHARS;
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
      bufStart = i + 2;
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

function stripBio(label: string): string {
  // BIO-prefixed labels: B-PERSON / I-PERSON → PERSON
  if (label.startsWith('B-') || label.startsWith('I-')) return label.slice(2);
  return label;
}

function severityFromScore(score: number): ScanFinding['severity'] {
  if (score >= 0.95) return 'high';
  if (score >= 0.85) return 'medium';
  return 'low';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}
