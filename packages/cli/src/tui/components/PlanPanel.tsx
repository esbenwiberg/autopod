import React from 'react';
import { Box, Text } from 'ink';

interface PlanPanelProps {
  summary: string;
  steps: string[];
  currentPhase?: number;
}

export function PlanPanel({ summary, steps, currentPhase }: PlanPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold dimColor>Plan</Text>
      <Text>{summary}</Text>
      {steps.map((step, i) => {
        const stepNum = i + 1;
        const isCurrent = currentPhase !== undefined && stepNum === currentPhase;
        const isDone = currentPhase !== undefined && stepNum < currentPhase;

        return (
          <Box key={i}>
            <Text color={isCurrent ? 'cyan' : isDone ? 'green' : undefined} dimColor={!isCurrent && !isDone}>
              {isCurrent ? '\u25B8 ' : isDone ? '\u2713 ' : '  '}
              {stepNum}. {step}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
