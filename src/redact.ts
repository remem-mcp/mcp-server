/**
 * Masks credentials before text is stored.
 *
 * AI agents sometimes paste a command line or config snippet into a log
 * entry. A work journal must never become a place where secrets are kept, so
 * anything that looks like a credential is replaced before it reaches the
 * database.
 */

export const REDACTED = "[REDACTED]";

export interface RedactionResult {
  text: string;
  /** Number of secrets that were masked */
  count: number;
}

type Rule = [pattern: RegExp, replacement: string];

const RULES: Rule[] = [
  // Private key blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Credentials inside URLs: scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, `$1:${REDACTED}@`],
  // Authorization headers
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, `$1 ${REDACTED}`],
  // Well-known token formats
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED],
  // key = value assignments such as "password: hunter2" or API_KEY="abc123"
  [
    /\b((?:[a-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:[_-][a-z0-9]+)*)(\s*[:=]\s*)(["']?)(?!\[REDACTED\])[^\s"'`,;]{4,}\3/gi,
    `$1$2$3${REDACTED}$3`,
  ],
  [/(パスワード|暗証番号|シークレット|秘密鍵)(\s*[:=:=]\s*)(?!\[REDACTED\])[^\s、。,;]{4,}/g, `$1$2${REDACTED}`],
];

/** Replace anything that looks like a credential with a placeholder */
export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  let result = text;
  for (const [pattern, replacement] of RULES) {
    result = result.replace(pattern, (...args: unknown[]) => {
      count += 1;
      const groups = args.slice(1, -2) as (string | undefined)[];
      return replacement.replace(/\$(\d)/g, (_, index: string) => groups[Number(index) - 1] ?? "");
    });
  }
  return { text: result, count };
}
