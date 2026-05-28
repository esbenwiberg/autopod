import { describe, expect, it } from 'vitest';
import { createProfileSchema, updateProfileSchema } from './profile.schema.js';

const canonicalModelMessage = 'canonical Claude model ID';

describe('createProfileSchema model validation', () => {
  it('rejects short Claude aliases in defaultModel, reviewerModel, and escalation.askAi.model', () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      const defaultModel = createProfileSchema.safeParse({ name: 'primary', defaultModel: model });
      expect(defaultModel.success).toBe(false);
      if (!defaultModel.success) {
        expect(defaultModel.error.issues[0]?.message).toContain(canonicalModelMessage);
      }

      const reviewerModel = createProfileSchema.safeParse({ name: 'primary', reviewerModel: model });
      expect(reviewerModel.success).toBe(false);
      if (!reviewerModel.success) {
        expect(reviewerModel.error.issues[0]?.message).toContain(canonicalModelMessage);
      }

      const askAiModel = createProfileSchema.safeParse({
        name: 'primary',
        escalation: { askAi: { model } },
      });
      expect(askAiModel.success).toBe(false);
      if (!askAiModel.success) {
        expect(askAiModel.error.issues[0]?.message).toContain(canonicalModelMessage);
      }
    }
  });

  it('accepts canonical Claude model IDs and materializes canonical defaults', () => {
    const parsed = createProfileSchema.parse({
      name: 'primary',
      defaultModel: 'claude-opus-4-8',
      reviewerModel: 'claude-sonnet-4-6',
      escalation: { askAi: { model: 'claude-sonnet-4-6' } },
    });

    expect(parsed.defaultModel).toBe('claude-opus-4-8');
    expect(parsed.reviewerModel).toBe('claude-sonnet-4-6');
    expect(parsed.escalation?.askAi.model).toBe('claude-sonnet-4-6');

    const defaulted = createProfileSchema.parse({ name: 'defaulted' });
    expect(defaulted.defaultModel).toBe('claude-opus-4-8');
    expect(defaulted.escalation?.askAi.model).toBe('claude-sonnet-4-6');
  });

  it('preserves null inheritance for model fields', () => {
    const derived = createProfileSchema.parse({ name: 'child', extends: 'parent' });
    expect(derived.defaultModel).toBeNull();
    expect(derived.reviewerModel).toBeNull();
    expect(derived.escalation).toBeNull();

    const updated = updateProfileSchema.parse({
      defaultModel: null,
      reviewerModel: null,
      escalation: null,
    });
    expect(updated.defaultModel).toBeNull();
    expect(updated.reviewerModel).toBeNull();
    expect(updated.escalation).toBeNull();
  });
});

describe('updateProfileSchema model validation', () => {
  it('rejects short Claude aliases in defaultModel, reviewerModel, and escalation.askAi.model', () => {
    for (const model of ['opus', 'sonnet', 'haiku']) {
      const defaultModel = updateProfileSchema.safeParse({ defaultModel: model });
      expect(defaultModel.success).toBe(false);
      if (!defaultModel.success) {
        expect(defaultModel.error.issues[0]?.message).toContain(canonicalModelMessage);
      }

      const reviewerModel = updateProfileSchema.safeParse({ reviewerModel: model });
      expect(reviewerModel.success).toBe(false);
      if (!reviewerModel.success) {
        expect(reviewerModel.error.issues[0]?.message).toContain(canonicalModelMessage);
      }

      const askAiModel = updateProfileSchema.safeParse({ escalation: { askAi: { model } } });
      expect(askAiModel.success).toBe(false);
      if (!askAiModel.success) {
        expect(askAiModel.error.issues[0]?.message).toContain(canonicalModelMessage);
      }
    }
  });
});
