import { Box, Text, useInput } from 'ink';
import type React from 'react';

interface DiffViewProps {
  diff: string;
  onClose: () => void;
}

/**
 * Display unified diff with basic coloring.
 * + lines green, - lines red, @@ lines cyan.
 */
export function DiffView({ diff, onClose }: DiffViewProps): React.ReactElement {
  useInput((_input, key) => {
    if (key.escape) {
      onClose();
    }
  });

  const lines = diff.split('\n');

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="gray">
      <Box justifyContent="space-between">
        <Text bold>Diff View</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => {
          let color: string | undefined;
          if (line.startsWith('+')) color = 'green';
          else if (line.startsWith('-')) color = 'red';
          else if (line.startsWith('@@')) color = 'cyan';

          return (
            <Text key={`${i}-${line}`} color={color}>
              {line}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
