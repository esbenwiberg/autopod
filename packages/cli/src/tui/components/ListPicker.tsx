import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface ListPickerProps<T> {
  title: string;
  items: T[];
  renderItem: (item: T, selected: boolean) => React.ReactElement;
  onSelect: (item: T) => void;
  onCancel: () => void;
  maxVisible?: number;
}

export function ListPicker<T>({
  title,
  items,
  renderItem,
  onSelect,
  onCancel,
  maxVisible = 10,
}: ListPickerProps<T>): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (items.length > 0) {
        onSelect(items[selectedIndex]!);
      }
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => Math.min(items.length - 1, prev + 1));
    }
  });

  if (items.length === 0) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">{title}</Text>
        <Text dimColor>No items available</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

  // Compute scroll window
  const windowStart = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
  const windowEnd = Math.min(items.length, windowStart + maxVisible);
  const visibleItems = items.slice(windowStart, windowEnd);

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">{title}</Text>
      {windowStart > 0 && <Text dimColor>  ↑ {windowStart} more</Text>}
      {visibleItems.map((item, i) => {
        const realIndex = windowStart + i;
        const isSelected = realIndex === selectedIndex;
        return (
          <Box key={`item-${realIndex}`}>
            <Text color={isSelected ? 'cyan' : undefined}>{isSelected ? '▸ ' : '  '}</Text>
            {renderItem(item, isSelected)}
          </Box>
        );
      })}
      {windowEnd < items.length && <Text dimColor>  ↓ {items.length - windowEnd} more</Text>}
      <Text dimColor>↑↓ navigate, Enter to select, Esc to cancel</Text>
    </Box>
  );
}
