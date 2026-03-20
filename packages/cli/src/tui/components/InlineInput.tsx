import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useState } from 'react';

interface InlineInputProps {
  prompt: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Single-line text input overlay.
 * Enter to submit, Escape to cancel.
 */
export function InlineInput({ prompt, onSubmit, onCancel }: InlineInputProps): React.ReactElement {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (value.trim().length > 0) {
        onSubmit(value.trim());
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    // Ignore control characters
    if (key.ctrl || key.meta) return;
    if (input) {
      setValue((prev) => prev + input);
    }
  });

  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">
        {prompt}
      </Text>
      <Box>
        <Text color="green">&gt; </Text>
        <Text>{value}</Text>
        <Text color="gray">_</Text>
      </Box>
      <Text dimColor>Enter to submit, Esc to cancel</Text>
    </Box>
  );
}
