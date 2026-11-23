import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { gatePinsSchema } from './combined-attestation.js';

/** An operator-provisioned public trust root, never read from the submitted enrollment. */
export async function readEvaluatorPublicPins(file: string | undefined) {
  try {
    if (!file || !path.isAbsolute(file)) throw new Error();
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || stat.mode & 0o022)
        throw new Error();
      const bytes = Buffer.alloc(stat.size + 1);
      let pos = 0;
      while (pos < bytes.length) {
        const { bytesRead } = await fd.read(bytes, pos, bytes.length - pos, pos);
        if (!bytesRead) break;
        pos += bytesRead;
      }
      if (pos !== stat.size) throw new Error();
      return gatePinsSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, pos))),
      );
    } finally {
      await fd.close();
    }
  } catch {
    throw new Error('independently-provisioned-public-policy-required');
  }
}
