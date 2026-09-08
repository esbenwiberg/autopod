import type { Command } from 'commander';
import * as config from '../config/config-store.js';
import { readCredentials } from '../config/credential-store.js';
import { managedRequest } from '../managed/transport.js';

/** Machine bridge: protocol on stdin/stdout, never tokens in arguments or output. */
export function registerManagedCommands(program: Command) {
  program
    .command('managed-request')
    .description('Bounded Dispatcher managed protocol bridge')
    .requiredOption('--endpoint <url>')
    .requiredOption('--issuer <issuer>')
    .requiredOption('--audience <audience>')
    .requiredOption('--object-id <id>')
    .action(async (options) => {
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of process.stdin) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > 2 * 1024 * 1024) throw new Error('input-too-large');
          chunks.push(bytes);
        }
        // Only read the existing login: no new cache, dev-token substitution, account selection,
        // interactive login, token export or credentials write from a Dispatcher request.
        const credential = readCredentials({ allowExpired: true });
        if (!credential) throw new Error('login-required');
        const result = await managedRequest(
          {
            endpoint: options.endpoint,
            issuer: options.issuer,
            audience: options.audience,
            objectId: options.objectId,
          },
          config.get('daemon') ?? '',
          credential.accessToken,
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch {
        process.stderr.write(
          'managed-request-unavailable; check the pinned connection and ap login\n',
        );
        process.exitCode = 1;
      }
    });
}
