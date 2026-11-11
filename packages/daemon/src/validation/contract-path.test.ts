import { describe, expect, it } from 'vitest';
import { normalizeContractPath } from './contract-path.js';

describe('Fact receipt path spelling', () => {
  it.each([
    ['source.js', 'source.js'],
    ['./source.js', 'source.js'],
    ['/source.js', 'source.js'],
    ['///./source.js', 'source.js'],
    ['nested/proof.json', 'nested/proof.json'],
    ['../outside', '../outside'],
  ])('retains the existing engine normalization for %s', (input, expected) => {
    expect(normalizeContractPath(input)).toBe(expected);
  });
});
