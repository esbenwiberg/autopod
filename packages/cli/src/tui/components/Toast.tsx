import { Text } from 'ink';
import type React from 'react';

interface ToastProps {
  message: string;
  color?: string;
}

export function Toast({ message, color = 'green' }: ToastProps): React.ReactElement {
  return <Text color={color}> {message}</Text>;
}
