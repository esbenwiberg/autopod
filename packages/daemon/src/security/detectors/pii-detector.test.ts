import { describe, expect, it, vi } from 'vitest';
import type { ModelManager, TokenClassificationItem, TokenClassifier } from '../model-manager.js';
import { chunkText, createPiiDetector, mergeSpans } from './pii-detector.js';

function fakeModelManager(classifier: TokenClassifier | null): ModelManager {
  return {
    getInjectionClassifier: vi.fn(async () => null),
    getPiiClassifier: vi.fn(async () => classifier),
    getStatus: () => ({
      injection: 'unloaded' as const,
      pii: classifier ? ('loaded' as const) : ('failed' as const),
    }),
  };
}

function tok(
  entity: string,
  word: string,
  score: number,
  index: number,
  start?: number,
  end?: number,
): TokenClassificationItem {
  return { entity, word, score, index, start, end };
}

describe('mergeSpans', () => {
  it('merges consecutive same-label tokens into a single span', () => {
    const tokens: TokenClassificationItem[] = [
      tok('B-PERSON', 'Alice', 0.99, 0),
      tok('I-PERSON', 'Smith', 0.97, 1),
      tok('O', 'works', 0.99, 2),
      tok('B-LOCATION', 'Paris', 0.95, 3),
    ];
    const spans = mergeSpans(tokens, 0.6);
    expect(spans).toHaveLength(2);
    expect(spans[0]?.label).toBe('PERSON');
    expect(spans[0]?.word).toContain('Alice');
    expect(spans[0]?.word).toContain('Smith');
    expect(spans[1]?.label).toBe('LOCATION');
    expect(spans[1]?.word).toBe('Paris');
  });

  it('drops a span whose mean score is below the floor', () => {
    const tokens: TokenClassificationItem[] = [
      tok('B-PERSON', 'Es', 0.55, 0),
      tok('I-PERSON', 'ben', 0.45, 1),
    ];
    // mean = 0.50, below floor of 0.6 → no span
    expect(mergeSpans(tokens, 0.6)).toHaveLength(0);
  });

  it('keeps a span whose mean score clears the floor even if a token is low', () => {
    // Real-world piiranha behavior: first wordpiece of a name scores high,
    // later wordpieces score lower. The whole entity should still emit.
    const tokens: TokenClassificationItem[] = [
      tok('B-PERSON', 'Es', 0.82, 0),
      tok('I-PERSON', '##ben', 0.5, 1),
      tok('I-PERSON', 'Wi', 0.71, 2),
      tok('I-PERSON', '##berg', 0.51, 3),
    ];
    const spans = mergeSpans(tokens, 0.6);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.word).toBe('Esben Wiberg');
  });

  it('returns no spans when every token is non-PII', () => {
    const tokens: TokenClassificationItem[] = [
      tok('O', 'this', 0.99, 0),
      tok('O', 'is', 0.99, 1),
      tok('O', 'fine', 0.99, 2),
    ];
    expect(mergeSpans(tokens, 0.6)).toHaveLength(0);
  });

  it('reports the mean score across a merged span', () => {
    const tokens: TokenClassificationItem[] = [
      tok('B-PERSON', 'Bob', 0.99, 0),
      tok('I-PERSON', 'X', 0.7, 1),
    ];
    const spans = mergeSpans(tokens, 0.6);
    expect(spans[0]?.score).toBeCloseTo(0.845, 3);
  });

  it('treats contiguous offsets as wordpieces without spaces (SentencePiece path)', () => {
    // SentencePiece tokenizers (e.g. mDeBERTa) don't use ## prefix — they
    // signal continuation via offset adjacency.
    const tokens: TokenClassificationItem[] = [
      tok('B-PERSON', 'Es', 0.9, 0, 0, 2),
      tok('I-PERSON', 'ben', 0.8, 1, 2, 5),
    ];
    const spans = mergeSpans(tokens, 0.6);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.word).toBe('Esben');
    expect(spans[0]?.start).toBe(0);
    expect(spans[0]?.end).toBe(5);
  });

  it('handles wordpiece tokens (## prefix) without spaces', () => {
    const tokens: TokenClassificationItem[] = [
      tok('B-PERSON', 'Alice', 0.99, 0),
      tok('I-PERSON', '##son', 0.99, 1),
    ];
    const spans = mergeSpans(tokens, 0.6);
    expect(spans[0]?.word).toBe('Aliceson');
  });
});

describe('chunkText', () => {
  it('splits on blank lines and tracks starting line numbers', () => {
    const content = `${'A'.repeat(40)}\n\n${'B'.repeat(40)}`;
    const chunks = chunkText(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.line).toBe(1);
    expect(chunks[1]?.line).toBe(3);
  });
});

describe('pii-detector', () => {
  it('returns empty when the model fails to load', async () => {
    const detector = createPiiDetector({ modelManager: fakeModelManager(null) });
    await detector.warmup();
    const findings = await detector.scan({
      path: 'fixtures/users.json',
      content: 'Alice Smith lives in Paris and her email is alice@example.com.',
      sizeBytes: 100,
    });
    expect(findings).toEqual([]);
  });

  it('emits findings for spans above the floor', async () => {
    const classifier: TokenClassifier = vi.fn(async (text) => {
      if (text.includes('Alice')) {
        return [
          tok('B-PERSON', 'Alice', 0.98, 0),
          tok('I-PERSON', 'Smith', 0.97, 1),
          tok('O', 'lives', 0.99, 2),
          tok('O', 'in', 0.99, 3),
          tok('B-LOCATION', 'Paris', 0.96, 4),
        ];
      }
      return [];
    });
    const detector = createPiiDetector({ modelManager: fakeModelManager(classifier) });
    const findings = await detector.scan({
      path: 'fixtures/users.json',
      content: 'Alice Smith lives in Paris and her name is in there too.',
      sizeBytes: 100,
    });
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.find((f) => f.ruleId === 'PERSON')).toBeDefined();
    expect(findings.find((f) => f.ruleId === 'LOCATION')).toBeDefined();
    const person = findings.find((f) => f.ruleId === 'PERSON');
    expect(person?.confidence).toBeGreaterThan(0.9);
    expect(person?.line).toBe(1);
    expect(person?.snippet).toContain('Alice');
  });

  it('survives a classifier that throws', async () => {
    const classifier: TokenClassifier = vi.fn(async () => {
      throw new Error('NER crash');
    });
    const detector = createPiiDetector({ modelManager: fakeModelManager(classifier) });
    const findings = await detector.scan({
      path: 'fixtures/users.json',
      content: 'A paragraph with at least thirty characters of text in it.',
      sizeBytes: 100,
    });
    expect(findings).toEqual([]);
  });
});
