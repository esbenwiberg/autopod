import { Box, Text, useInput } from 'ink';
import type React from 'react';

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Y/N confirmation overlay.
 */
export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onConfirm();
    } else if (input === 'n' || input === 'N' || key.escape) {
      onCancel();
    }
  });

  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column">
      <Text bold color="red">
        {message}
      </Text>
      <Text>
        Press{' '}
        <Text bold color="green">
          Y
        </Text>{' '}
        to confirm or{' '}
        <Text bold color="red">
          N
        </Text>{' '}
        to cancel
      </Text>
    </Box>
  );
}
