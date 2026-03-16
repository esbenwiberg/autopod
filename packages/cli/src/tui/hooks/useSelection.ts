import { useState, useCallback, useEffect } from 'react';

export interface UseSelectionReturn {
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
  moveUp: () => void;
  moveDown: () => void;
}

/**
 * Arrow key navigation with bounds checking.
 * Adjusts the index when the list shrinks.
 */
export function useSelection(itemCount: number): UseSelectionReturn {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Clamp index when list changes size
  useEffect(() => {
    if (itemCount === 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((prev) => Math.min(prev, itemCount - 1));
  }, [itemCount]);

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => Math.min(itemCount - 1, prev + 1));
  }, [itemCount]);

  return { selectedIndex, setSelectedIndex, moveUp, moveDown };
}
