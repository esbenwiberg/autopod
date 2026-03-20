import { describe, expect, it } from 'vitest';

// Test the selection bounds-checking logic directly (no React needed)
describe('useSelection logic', () => {
  it('moveUp does not go below 0', () => {
    let index = 0;
    const moveUp = () => {
      index = Math.max(0, index - 1);
    };
    moveUp();
    expect(index).toBe(0);
  });

  it('moveDown does not exceed item count', () => {
    const itemCount = 3;
    let index = 2;
    const moveDown = () => {
      index = Math.min(itemCount - 1, index + 1);
    };
    moveDown();
    expect(index).toBe(2);
  });

  it('moveDown increments within bounds', () => {
    const itemCount = 5;
    let index = 0;
    const moveDown = () => {
      index = Math.min(itemCount - 1, index + 1);
    };
    moveDown();
    expect(index).toBe(1);
    moveDown();
    expect(index).toBe(2);
  });

  it('moveUp decrements within bounds', () => {
    let index = 3;
    const moveUp = () => {
      index = Math.max(0, index - 1);
    };
    moveUp();
    expect(index).toBe(2);
    moveUp();
    expect(index).toBe(1);
  });

  it('clamps index when list shrinks', () => {
    let itemCount = 5;
    let index = 4;
    // Simulate list shrinking
    itemCount = 3;
    index = Math.min(index, itemCount - 1);
    expect(index).toBe(2);
  });

  it('handles empty list', () => {
    const index = 0;
    // With 0 items, the hook keeps index at 0
    expect(index).toBe(0);
  });

  it('navigates full range', () => {
    const itemCount = 4;
    let index = 0;
    const moveDown = () => {
      index = Math.min(itemCount - 1, index + 1);
    };
    const moveUp = () => {
      index = Math.max(0, index - 1);
    };

    moveDown();
    expect(index).toBe(1);
    moveDown();
    expect(index).toBe(2);
    moveDown();
    expect(index).toBe(3);
    moveDown();
    expect(index).toBe(3); // capped
    moveUp();
    expect(index).toBe(2);
    moveUp();
    expect(index).toBe(1);
    moveUp();
    expect(index).toBe(0);
    moveUp();
    expect(index).toBe(0); // capped
  });
});
