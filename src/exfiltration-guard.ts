/** Exfiltration guard — scans outbound text for leaked secrets before Telegram delivery. */

export interface ScanResult {
  clean: boolean;
  /** Pattern names that matched. Empty if clean. */
  matches: string[];
}

/** Each pattern has a name (for logging) and a regex. */
interface SecretPattern {
  name: string;
  regex: RegExp;
}

/**
 * 16 secret detection patterns covering API keys, tokens, private keys,
 * and encoded variants. Patterns are anchored to reduce false positives
 * on code examples that mention key formats without containing real keys.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // AWS — access keys have a distinctive AKIA prefix; secret keys lack one so we skip them
  // (matching any 40-char string would false-positive on git SHAs and SHA-1 hashes)
  { name: "aws-access-key", regex: /(?<![A-Za-z0-9/+=])AKIA[0-9A-Z]{16}(?![A-Za-z0-9/+=])/g },

  // GitHub
  { name: "github-pat", regex: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g },
  { name: "github-oauth", regex: /(?<![A-Za-z0-9_])gho_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g },
  { name: "github-app", regex: /(?<![A-Za-z0-9_])ghs_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g },
  { name: "github-refresh", regex: /(?<![A-Za-z0-9_])ghr_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g },

  // Anthropic
  { name: "anthropic-key", regex: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },

  // OpenAI
  { name: "openai-key", regex: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}(?![A-Za-z0-9_-])/g },

  // Slack
  { name: "slack-token", regex: /(?<![A-Za-z0-9_-])xox[bpors]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9_-])/g },

  // Stripe
  { name: "stripe-key", regex: /(?<![A-Za-z0-9_])(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}(?![A-Za-z0-9_])/g },

  // Telegram bot token (don't leak our own or others')
  { name: "telegram-bot-token", regex: /(?<![0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },

  // Generic Bearer token in output
  { name: "bearer-token", regex: /Bearer\s+[A-Za-z0-9_\-.]{20,}/gi },

  // Private keys (PEM blocks)
  { name: "private-key", regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g },

  // Google API key
  { name: "google-api-key", regex: /(?<![A-Za-z0-9_])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },

  // Base64-encoded "sk-ant-" or "AKIA" prefixed secrets
  { name: "base64-anthropic", regex: /(?<![A-Za-z0-9/+=])c2stYW50L[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9/+=])/g },
  { name: "base64-aws", regex: /(?<![A-Za-z0-9/+=])QUtJQ[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9/+=])/g },

  // URL-encoded secrets (sk-ant- → sk-ant%2D or sk%2Dant)
  { name: "url-encoded-key", regex: /sk(?:%2[dD]|-|%252[dD])ant(?:%2[dD]|-|%252[dD])[A-Za-z0-9%_-]{10,}/g },

];

/**
 * Scan text for potential secrets. Returns match details.
 * Runs all 16 patterns against the text.
 */
export function scanForSecrets(text: string): ScanResult {
  const matches: string[] = [];

  for (const pattern of SECRET_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      matches.push(pattern.name);
    }
  }

  return { clean: matches.length === 0, matches };
}

/** Format a redaction warning message for Telegram. */
export function formatRedactionWarning(matches: string[]): string {
  const types = matches.join(", ");
  return `\u{1F6A8} **Response blocked by exfiltration guard**\n\nDetected potential secret(s): ${types}\n\nThe response was not sent to protect your security. If this is a false positive, review the agent's output in the session logs.`;
}
