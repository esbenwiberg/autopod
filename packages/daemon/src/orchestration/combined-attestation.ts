import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { canonical, digest } from '../managed/canonical.js';

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identity = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const base64url = (bytes: number) =>
  z.string().refine((s) => {
    if (s.length !== Math.ceil((bytes * 4) / 3)) return false;
    const decoded = Buffer.from(s, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === s;
  });
const authority = z
  .object({ identity, configurationDigest: hash, publicKey: base64url(32) })
  .strict();
export const gatePolicySchema = z
  .object({ basePolicyDigest: hash, checks: authority, independentReview: authority })
  .strict()
  .refine(
    (p) =>
      p.checks.identity !== p.independentReview.identity &&
      p.checks.publicKey !== p.independentReview.publicKey,
  );
export type CombinedPolicy = z.infer<typeof gatePolicySchema>;
export type Role = 'checks' | 'independentReview';
const statementSchema = z
  .object({
    role: z.enum(['checks', 'independentReview']),
    identity,
    configurationDigest: hash,
    inputDigest: hash,
    status: z.enum(['passed', 'failed']),
    evidenceDigest: hash,
  })
  .strict();
export type GateStatement = z.infer<typeof statementSchema>;
export const signedGateSchema = z
  .object({ statement: statementSchema, signature: base64url(64) })
  .strict();
export type SignedGateReceipt = z.infer<typeof signedGateSchema>;

/** Freeze this digest at run creation. The base digest retains other run restrictions. */
export function combinedPolicyDigest(policy: CombinedPolicy) {
  return digest(['autopod.combined-policy.v1', gatePolicySchema.parse(policy)]);
}
export function gateStatementBytes(statement: GateStatement) {
  return Buffer.from(canonical(['autopod.combined-gate.v1', statementSchema.parse(statement)]));
}
/** Verify against the key in the pinned policy, never a key supplied with a result. */
export function verifyGateReceipt(
  policy: CombinedPolicy,
  role: Role,
  inputDigest: string,
  raw: unknown,
) {
  const parsed = signedGateSchema.safeParse(raw);
  if (parsed.success) {
    const { statement: s, signature } = parsed.data;
    const expected = policy[role];
    const key = createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: expected.publicKey },
    });
    if (
      s.role === role &&
      s.identity === expected.identity &&
      s.configurationDigest === expected.configurationDigest &&
      s.inputDigest === inputDigest &&
      s.status === 'passed' &&
      verify(null, gateStatementBytes(s), key, Buffer.from(signature, 'base64url'))
    ) {
      return {
        status: 'passed' as const,
        receiptDigest: digest(parsed.data),
        receipt: parsed.data,
      };
    }
  }
  throw new Error(`combined-${role}-required`);
}
