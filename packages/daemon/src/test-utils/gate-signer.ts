import { generateKeyPairSync, sign } from 'node:crypto';
import {
  type GateStatement,
  gateStatementBytes,
  type Role,
} from '../orchestration/combined-attestation.js';

// Each offline backend owns its own ephemeral signing key. Only public material travels
// in run policy or custody; the scheduler has no signing API.
export function fixtureSigner(role: Role, identity: string, configurationDigest: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (!x) throw new Error('missing public key');
  return {
    authority: { identity, configurationDigest, publicKey: x },
    attest(result: Pick<GateStatement, 'status' | 'inputDigest' | 'evidenceDigest'>) {
      const statement = { role, identity, configurationDigest, ...result };
      return {
        statement,
        signature: sign(null, gateStatementBytes(statement), privateKey).toString('base64url'),
      };
    },
  };
}
