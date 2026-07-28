import {
  type ProviderFailureCategory,
  type ProviderFailureClassification,
  type RuntimeType,
  processContent,
} from '@autopod/shared';

export interface ProviderErrorEvidence {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  retryAfter?: unknown;
}

const MAX_MESSAGE_LENGTH = 1_200;
const AUTHORIZATION_CREDENTIAL =
  /(\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+)[a-z0-9._~+/-]+=*/gi;
const LABELED_SECRET =
  /(\b(?:bearer|token|api[_ -]?key|secret|password)\s*[:=]\s*)["']?[^\s,"'}]+/gi;
const UNLABELED_SECRETS = [/\bsk-[a-z0-9_-]{12,}\b/gi, /\bgh[opusr]_[a-z0-9]{12,}\b/gi];

const STRUCTURED_QUOTA_SIGNATURES: Readonly<
  Record<Exclude<RuntimeType, 'copilot'>, readonly { code: string; message: RegExp }[]>
> = {
  claude: [
    { code: 'usage_limit_reached', message: /^You've hit your usage limit$/i },
    { code: 'billing_error', message: /^Claude usage limit reached$/i },
  ],
  codex: [
    { code: 'usage_limit_reached', message: /^You've hit your usage limit\.$/i },
    { code: 'insufficient_quota', message: /^Codex usage limit reached$/i },
  ],
  pi: [
    { code: 'usage_limit_reached', message: /^Provider usage limit reached$/i },
    { code: 'quota_exceeded', message: /^Provider quota exhausted$/i },
  ],
};
const CLAUDE_TERMINAL_SESSION_LIMIT =
  /^You've hit your session limit · resets (?:[1-9]|1[0-2]):[0-5]\d(?:am|pm) \(UTC\)$/;
const COPILOT_QUOTA_MESSAGES = [
  /^You have exhausted your premium requests\.$/i,
  /^Copilot premium request limit reached$/i,
];

const AUTH_CODES = new Set(['authentication_error', 'invalid_api_key', 'unauthorized']);
const AUTH_MESSAGE =
  /^(?:authentication failed|invalid api key|not authenticated|unauthorized)(?:[.: ].*)?$/i;
const OUTAGE_CODES = new Set(['provider_unavailable', 'service_unavailable', 'overloaded']);
const OUTAGE_MESSAGE =
  /^(?:provider|service) (?:is )?(?:temporarily )?unavailable(?:[.: ].*)?$|^overloaded(?:[.: ].*)?$/i;
const TRANSIENT_CODES = new Set(['rate_limit_exceeded', 'too_many_requests', 'throttled']);
const TRANSIENT_MESSAGE =
  /^(?:rate limit(?:ed| exceeded)?|too many requests|temporarily throttled)(?:[.: ].*)?$/i;

export function classifyProviderError(
  runtime: RuntimeType,
  evidence: ProviderErrorEvidence,
): ProviderFailureClassification {
  return classify(runtime, evidence, false);
}

/**
 * Classifies Pi evidence only after the parser observes Pi's native
 * `agent_settled` event. Callers must not derive settlement from provider payloads.
 */
export function classifySettledPiProviderError(
  evidence: ProviderErrorEvidence,
): ProviderFailureClassification {
  return classify('pi', evidence, true);
}

function classify(
  runtime: RuntimeType,
  evidence: ProviderErrorEvidence,
  piAgentSettled: boolean,
): ProviderFailureClassification {
  const rawMessage = typeof evidence.message === 'string' ? evidence.message : '';
  const sanitizedMessage = sanitizeProviderMessage(rawMessage || `${runtime} provider error`);
  const code = normalizeCode(evidence.code);
  const status = typeof evidence.status === 'number' ? evidence.status : null;
  const retryAfter = normalizeRetryAfter(evidence.retryAfter);

  const quotaSignature =
    runtime === 'copilot'
      ? COPILOT_QUOTA_MESSAGES.some((pattern) => pattern.test(rawMessage.trim()))
      : (runtime === 'claude' && CLAUDE_TERMINAL_SESSION_LIMIT.test(rawMessage.trim())) ||
        (code !== null &&
          STRUCTURED_QUOTA_SIGNATURES[runtime].some(
            (signature) => signature.code === code && signature.message.test(rawMessage.trim()),
          ));
  const terminalQuota = quotaSignature && (runtime !== 'pi' || piAgentSettled);
  if (terminalQuota) {
    return classification('quota_exhausted', true, sanitizedMessage, retryAfter);
  }

  // Structured provider evidence outranks a generic transport status. Some
  // gateways use 429 for account/auth policy failures as well as throttling.
  if ((code !== null && AUTH_CODES.has(code)) || AUTH_MESSAGE.test(rawMessage.trim())) {
    return classification('auth', false, sanitizedMessage, retryAfter);
  }
  if ((code !== null && OUTAGE_CODES.has(code)) || OUTAGE_MESSAGE.test(rawMessage.trim())) {
    return classification('provider_unavailable', false, sanitizedMessage, retryAfter);
  }
  if (
    status === 429 ||
    (code !== null && TRANSIENT_CODES.has(code)) ||
    TRANSIENT_MESSAGE.test(rawMessage.trim()) ||
    (quotaSignature && runtime === 'pi')
  ) {
    return classification('transient', false, sanitizedMessage, retryAfter);
  }
  return classification('unknown', false, sanitizedMessage, retryAfter);
}

export function sanitizeProviderMessage(message: string): string {
  let sanitized = Array.from(message, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  sanitized = sanitized.replace(AUTHORIZATION_CREDENTIAL, '$1[REDACTED]');
  sanitized = sanitized.replace(LABELED_SECRET, '$1[REDACTED]');
  for (const pattern of UNLABELED_SECRETS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  sanitized = processContent(sanitized, { sanitization: { preset: 'standard' } }).text.trim();
  if (!sanitized) return 'Provider returned an unrecognized error';
  return sanitized.length > MAX_MESSAGE_LENGTH
    ? `${sanitized.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : sanitized;
}

function classification(
  category: ProviderFailureCategory,
  definitive: boolean,
  sanitizedMessage: string,
  retryAfter: string | null,
): ProviderFailureClassification {
  return { category, definitive, sanitizedMessage, retryAfter };
}

function normalizeCode(code: unknown): string | null {
  return typeof code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? code.toLowerCase() : null;
}

function normalizeRetryAfter(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{1,8}$/.test(trimmed)) return trimmed;
  return null;
}
