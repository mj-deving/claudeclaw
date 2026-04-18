/** Environment configuration with validation. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  allowedChatIds: new Set(
    required("ALLOWED_CHAT_IDS")
      .split(",")
      .map((id) => {
        const parsed = Number(id.trim());
        if (Number.isNaN(parsed)) {
          throw new Error(`Invalid chat ID: ${id.trim()}`);
        }
        return parsed;
      }),
  ),
  agentMaxTurns: Number(optional("AGENT_MAX_TURNS", "30")),
  agentTimeoutMs: Number(optional("AGENT_TIMEOUT_MS", "900000")),
  agentCwd: optional("AGENT_CWD", process.env.HOME ?? "/home"),

  // Security — PIN lock (optional: omit PIN_HASH to disable locking)
  pinHash: process.env.PIN_HASH ?? "",
  pinSalt: (() => {
    const hash = process.env.PIN_HASH ?? "";
    const salt = process.env.PIN_SALT ?? "";
    if (hash && !salt) {
      throw new Error("PIN_SALT is required when PIN_HASH is set. Generate both with: bun run scripts/hash-pin.ts <pin>");
    }
    return salt;
  })(),
  idleLockMs: Number(optional("IDLE_LOCK_MINUTES", "30")) * 60_000,
} as const;
