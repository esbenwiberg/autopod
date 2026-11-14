/**
 * Bounds captured command output while keeping BOTH ends.
 *
 * Validation commands (build, test, lint, SAST, setup) print their context first
 * and their verdict last: a large test suite reports thousands of passing lines
 * before the failure details and summary. Keeping only the head of such output
 * hides exactly the part that explains the failure, so stored results and agent
 * feedback retain a short head plus a long tail separated by an explicit marker.
 *
 * Limits are measured in UTF-16 code units (JavaScript string length), matching
 * the historical `slice(0, 50_000)` cap. Cut points never split a surrogate
 * pair, so the bounded text always encodes to valid UTF-8.
 */

/** Maximum stored size of one validation output field. */
export const VALIDATION_OUTPUT_LIMIT = 50_000;
/** Portion of {@link VALIDATION_OUTPUT_LIMIT} reserved for the beginning of the output. */
export const VALIDATION_OUTPUT_HEAD = 10_000;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function outputTruncationMarker(omitted: number): string {
  return `\n\n[... ${omitted} characters omitted; beginning and end of output retained ...]\n\n`;
}

/**
 * Join a known prefix and suffix of a longer text. `start` must be a prefix of
 * the original text and `end` a suffix, each at least as long as the part kept
 * from it; `totalLength` is the original text length.
 */
function joinBounded(
  start: string,
  end: string,
  totalLength: number,
  limit: number,
  headLimit: number,
): string {
  // The marker for the largest possible omission is never shorter than the
  // final marker, so reserving it keeps the result within `limit`.
  const reserve = outputTruncationMarker(totalLength).length;
  if (limit <= reserve) return safeTail(end, Math.max(0, limit));
  const available = limit - reserve;
  let headLen = Math.min(headLimit, available, start.length);
  if (headLen > 0 && isHighSurrogate(start.charCodeAt(headLen - 1))) headLen -= 1;
  const tail = safeTail(end, available - headLen);
  const omitted = totalLength - headLen - tail.length;
  return start.slice(0, headLen) + outputTruncationMarker(omitted) + tail;
}

function safeTail(text: string, length: number): string {
  if (length <= 0) return '';
  let from = Math.max(0, text.length - length);
  if (from > 0 && from < text.length && isLowSurrogate(text.charCodeAt(from))) from += 1;
  return text.slice(from);
}

/** Bound `text` to `limit`, keeping up to `headLimit` leading and the remaining trailing characters. */
export function boundOutput(
  text: string,
  limit = VALIDATION_OUTPUT_LIMIT,
  headLimit = VALIDATION_OUTPUT_HEAD,
): string {
  if (text.length <= limit) return text;
  return joinBounded(text, text, text.length, limit, headLimit);
}

/**
 * Incrementally collects streamed output in bounded memory and yields the same
 * result as {@link boundOutput} applied to the full concatenated stream.
 */
export class BoundedOutputCollector {
  private head = '';
  private tail = '';
  private total = 0;

  constructor(
    private readonly limit = VALIDATION_OUTPUT_LIMIT,
    private readonly headLimit = VALIDATION_OUTPUT_HEAD,
  ) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    // One spare code unit lets the head cut step back from a split surrogate pair.
    if (this.head.length <= this.headLimit) {
      this.head = (this.head + chunk).slice(0, this.headLimit + 1);
    }
    // Keep one spare code unit so a tail cut can skip a dangling low surrogate.
    const combined = this.tail + chunk;
    this.tail = combined.length > this.limit + 1 ? combined.slice(-(this.limit + 1)) : combined;
  }

  toString(): string {
    if (this.total <= this.limit) return this.tail;
    return joinBounded(this.head, this.tail, this.total, this.limit, this.headLimit);
  }
}
