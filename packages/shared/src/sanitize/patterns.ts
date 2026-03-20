// ─── PII Patterns ───────────────────────────────────────────────
// Each pattern has a regex, a replacer function, and a description.

export interface PiiPattern {
  name: string;
  regex: RegExp;
  replacement: string;
  /** Which presets include this pattern */
  presets: ('strict' | 'standard' | 'relaxed')[];
}

export const PII_PATTERNS: PiiPattern[] = [
  // API keys/secrets run first — prevent partial matches by less-specific patterns (e.g. phone matching digits in a token)
  {
    name: 'api-key',
    // Common API key patterns: sk-*, ghp_*, gho_*, ghs_*, ghr_*, xoxb-, xoxp-, JWTs
    regex: /(?:sk-[a-zA-Z0-9]{20,}|gh[pors]_[a-zA-Z0-9]{36,}|xox[bpoas]-[a-zA-Z0-9-]{10,}|eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,})/g,
    replacement: '[API_KEY_REDACTED]',
    presets: ['strict', 'standard', 'relaxed'],
  },
  {
    name: 'aws-access-key',
    regex: /\b(AKIA[0-9A-Z]{16})\b/g,
    replacement: '[AWS_KEY_REDACTED]',
    presets: ['strict', 'standard', 'relaxed'],
  },
  {
    name: 'azure-connection-string',
    regex: /AccountKey=[a-zA-Z0-9+/=]{40,}/g,
    replacement: 'AccountKey=[REDACTED]',
    presets: ['strict', 'standard', 'relaxed'],
  },
  {
    name: 'email',
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL_REDACTED]',
    presets: ['strict', 'standard'],
  },
  {
    name: 'phone',
    regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    replacement: '[PHONE_REDACTED]',
    presets: ['strict'],
  },
  {
    name: 'ipv4',
    // Match IPv4 but exclude common non-PII like 0.0.0.0, 127.0.0.1, 169.254.*
    regex: /\b(?!0\.0\.0\.0|127\.0\.0\.1|169\.254\.)(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: '[IP_REDACTED]',
    presets: ['strict'],
  },
];

/** Field names that should be entirely redacted when encountered in objects */
export const REDACT_FIELD_NAMES: ReadonlySet<string> = new Set([
  'email',
  'user_email',
  'userEmail',
  'author_email',
  'authorEmail',
  'committer_email',
  'committerEmail',
  'password',
  'secret',
  'token',
  'api_key',
  'apiKey',
  'access_token',
  'accessToken',
  'private_key',
  'privateKey',
]);

// ─── Injection Detection Patterns ───────────────────────────────

export interface InjectionPattern {
  name: string;
  regex: RegExp;
  severity: number; // 0-1 contribution to threat score
  description: string;
}

export const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    name: 'direct-instruction',
    regex: /\b(ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|context|rules?))\b/i,
    severity: 0.8,
    description: 'Direct instruction override attempt',
  },
  {
    name: 'role-manipulation',
    regex: /\b(you\s+are\s+(now|actually)|from\s+now\s+on\s+you|new\s+instructions?:|system\s*:\s*you)\b/i,
    severity: 0.7,
    description: 'Attempt to redefine agent role',
  },
  {
    name: 'token-boundary',
    regex: /(```\s*(system|assistant|human)\b|<\|?(system|endoftext|im_start)\|?>)/i,
    severity: 0.9,
    description: 'Token boundary / delimiter injection',
  },
  {
    name: 'exfiltration',
    regex: /\b(send\s+.*?\s+(to\s+)?https?:\/\/|fetch\s+https?:\/\/|curl\s+-|wget\s+)/i,
    severity: 0.6,
    description: 'Potential data exfiltration instruction',
  },
  {
    name: 'tool-abuse',
    regex: /\b(call\s+the\s+tool|use\s+the\s+function|execute\s+(the\s+)?command|run\s+(the\s+)?script)\b/i,
    severity: 0.5,
    description: 'Attempt to invoke agent tools',
  },
  {
    name: 'encoding-trick',
    regex: /(?:&#x?[0-9a-f]+;|%[0-9a-f]{2}|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}){3,}/i,
    severity: 0.4,
    description: 'Encoded content that may hide injection',
  },
  {
    name: 'xml-tag-injection',
    regex: /<\s*(?:system-prompt|instructions|claude|anthropic|tool_call|function_call)\s*>/i,
    severity: 0.8,
    description: 'XML tag mimicking system/tool boundaries',
  },
];
