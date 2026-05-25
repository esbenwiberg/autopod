import { describe, expect, it } from 'vitest';
import {
  planLabel,
  progressLabel,
  taskPreview,
  taskTitle,
  validationLabel,
} from './pod-display.js';

describe('pod display helpers', () => {
  it('extracts a concise title from markdown task text', () => {
    expect(taskTitle('## Task Move frontend calls\n\nLong body')).toBe('Move frontend calls');
  });

  it('skips generic task headings', () => {
    expect(taskTitle('## Task\nMove frontend calls\n\nLong body')).toBe('Move frontend calls');
  });

  it('builds a preview without repeating the title', () => {
    expect(taskPreview('## Task Move frontend calls\n\nRegenerate the generated client.')).toBe(
      'Regenerate the generated client.',
    );
  });

  it('summarizes progress with phase counts', () => {
    expect(
      progressLabel({
        progress: {
          phase: 'Implementing',
          description: 'Editing mobile UI',
          currentPhase: 2,
          totalPhases: 4,
        },
      }),
    ).toBe('Phase 2/4: Implementing');
  });

  it('summarizes plan and validation', () => {
    expect(planLabel({ plan: { summary: 'Do the thing', steps: [] } })).toBe('Do the thing');
    expect(validationLabel({ attempt: 3, overall: 'fail' } as never)).toBe('Validation #3: fail');
  });
});
