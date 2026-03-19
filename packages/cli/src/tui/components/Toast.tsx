import React from 'react';
import { Text } from 'ink';

interface ToastProps {
  message: string;
  color?: string;
}

export function Toast({ message, color = 'green' }: ToastProps): React.ReactElement {
  return <Text color={color}> {message}</Text>;
}
