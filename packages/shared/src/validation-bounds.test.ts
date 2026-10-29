import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('bounded validation resource consumption', () => {
  it('rejects oversized primitive arrays in an object validator before producing child issues', () => {
    const schema = z.object({ items: z.array(z.string()).max(2) });
    for (let run = 0; run < 2; run++) {
      const result = schema.safeParse({ items: [1, 2, 3] });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Oversized object array unexpectedly accepted');
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({ code: 'too_big', path: ['items'] });
    }
  });
  it('rejects oversized arrays before parsing children or running refinements', () => {
    let children = 0;
    let refinements = 0;
    const schema = z
      .array(
        z.string().refine(() => {
          children++;
          return true;
        }),
      )
      .max(2)
      .refine(() => {
        refinements++;
        return true;
      });
    const result = schema.safeParse(['a', 'b', 'c']);
    expect(result.success).toBe(false);
    expect(children).toBe(0);
    expect(refinements).toBe(0);
    if (result.success) throw new Error('Oversized input unexpectedly accepted');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.code).toBe('too_big');
  });
});
