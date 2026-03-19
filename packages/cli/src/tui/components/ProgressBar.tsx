import React from 'react';
import { Box, Text } from 'ink';

interface ProgressBarProps {
  currentPhase: number;
  totalPhases: number;
  phase: string;
  description: string;
  width?: number;
}

const PHASE_COLORS: Record<string, string> = {
  exploration: 'red',
  planning: 'red',
  analysis: 'red',
  investigation: 'red',
  design: 'magenta',
  implementation: 'yellow',
  build: 'yellow',
  fix: 'yellow',
  testing: 'blue',
  test: 'blue',
  verify: 'blue',
  validation: 'green',
  cleanup: 'green',
  document: 'green',
};

function getPhaseColor(phase: string): string {
  const lower = phase.toLowerCase();
  for (const [key, color] of Object.entries(PHASE_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return 'cyan';
}

export function ProgressBar({ currentPhase, totalPhases, phase, description, width = 20 }: ProgressBarProps): React.ReactElement {
  const filled = Math.round((currentPhase / totalPhases) * width);
  const empty = width - filled;
  const color = getPhaseColor(phase);

  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{'Progress: '}</Text>
        <Text color={color}>{bar}</Text>
        <Text> {currentPhase}/{totalPhases}</Text>
      </Box>
      <Box>
        <Text dimColor>{'Phase:    '}</Text>
        <Text color={color} bold>{phase}</Text>
        <Text dimColor> — {description}</Text>
      </Box>
    </Box>
  );
}
