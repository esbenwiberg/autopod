import { AutopodError } from '@autopod/shared';
import chalk from 'chalk';

const EXIT_CODES: Record<string, number> = {
  AUTH_ERROR: 2,
  FORBIDDEN: 2,
  SESSION_NOT_FOUND: 3,
  PROFILE_NOT_FOUND: 3,
  VALIDATION_ERROR: 4,
  DAEMON_UNREACHABLE: 5,
};

const SUGGESTIONS: Record<string, string> = {
  AUTH_ERROR: 'Try: ap login',
  FORBIDDEN: 'You do not have permission for this action.',
  SESSION_NOT_FOUND: 'Check the session ID with: ap ls',
  PROFILE_NOT_FOUND: 'Check available profiles with: ap profile ls',
  VALIDATION_ERROR: 'Check input and try again.',
  DAEMON_UNREACHABLE: 'Try: ap connect <url>',
  INSTALL_FAILED:
    'Set networkPolicy to "allow-all" in your profile, or add the required package domains to the allowlist.',
  AUTH_FAILED: 'Check that the PAT in your profile is valid and has the required scopes.',
};

export function handleError(error: unknown): never {
  if (error instanceof AutopodError) {
    console.error(chalk.red(`Error: ${error.message}`));
    const suggestion = SUGGESTIONS[error.code];
    if (suggestion) {
      console.error(chalk.dim(suggestion));
    }
    const exitCode = EXIT_CODES[error.code] ?? 1;
    process.exit(exitCode);
  }

  if (error instanceof Error) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }

  console.error(chalk.red('An unknown error occurred'));
  process.exit(1);
}

export function getExitCode(error: unknown): number {
  if (error instanceof AutopodError) {
    return EXIT_CODES[error.code] ?? 1;
  }
  return 1;
}
