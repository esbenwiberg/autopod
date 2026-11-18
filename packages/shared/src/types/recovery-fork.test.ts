import { describe, expect, it } from 'vitest';
import {
  recoveryForkInputSchema,
  recoveryForkRequestSchema,
  recoveryHandoffPreparationSchema,
} from './recovery-fork.js';

const input = {
  version: 1,
  expectedGeneration: 3,
  sourceHead: 'a'.repeat(40),
  executionProfileId: '@original',
  instructions: 'Continue from the saved checkpoint and address the recorded failure.',
  files: [],
  acknowledgePartialSource: true,
};
describe('explicit recovery fork contract', () => {
  it('requires source and partial-source acknowledgement without accepting authority overrides', () => {
    expect(recoveryForkInputSchema.parse(input)).toEqual(input);
    for (const change of [
      { acknowledgePartialSource: false },
      { instructions: 'x'.repeat(8001) },
      { expectedGeneration: 0 },
      { sourceHead: 'main' },
      { actor: 'admin' },
      { tokenBudget: 1000000 },
      { autoApprove: true },
    ]) {
      expect(recoveryForkInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it('accepts an optional note while keeping preparation free of execution authority', () => {
    const { instructions: _note, ...withoutNote } = input;
    expect(recoveryForkInputSchema.parse(withoutNote).instructions).toBe('');
    expect(recoveryForkInputSchema.parse({ ...input, instructions: '  ' }).instructions).toBe('');
    expect(recoveryHandoffPreparationSchema.parse({ expectedGeneration: 3 })).toEqual({
      expectedGeneration: 3,
      instructions: '',
    });
    for (const change of [
      { execute: true },
      { actorId: 'human' },
      { tokenBudget: 100 },
      { expectedGeneration: 0 },
    ])
      expect(
        recoveryHandoffPreparationSchema.safeParse({ expectedGeneration: 3, ...change }).success,
      ).toBe(false);
  });
  it('binds one immutable request key and reviewed selection; rejects duplicate supplemental paths', () => {
    expect(
      recoveryForkRequestSchema.safeParse({
        ...input,
        id: 'decision',
        expectedBinding: 'b'.repeat(64),
      }).success,
    ).toBe(true);
    expect(recoveryForkRequestSchema.safeParse({ ...input, id: 'decision' }).success).toBe(false);
    const file = { path: 'notes.txt', version: 'c'.repeat(64) };
    expect(recoveryForkInputSchema.safeParse({ ...input, files: [file, file] }).success).toBe(
      false,
    );
    expect(
      recoveryForkInputSchema.safeParse({
        ...input,
        files: Array.from({ length: 101 }, (_, i) => ({ ...file, path: `${i}.txt` })),
      }).success,
    ).toBe(false);
  });
});
