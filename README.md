# ClaudeClaw

Mobile surface of [PAI](https://github.com/mj-deving/Pai-Exploration) (Personal AI Infrastructure). A Telegram bot backed by the Claude Agent SDK with full PAI context.

## What it does

- **Text + voice** messages via Telegram, routed to a PAI-aware Claude agent
- **Fast-path capture** — bare URLs, `/add`, `/url`, `/memo`, `/remind` write directly to INBOX.md (no AI cost)
- **Streaming responses** — progressive edits to a single Telegram message as the agent works
- **Voice transcription** — Groq Whisper STT, then routed through the agent
- **Triage commands** — `/review`, `/approve <n>`, `/discard <n>` for the mx daemon pipeline
- **Security** — chat ID allowlist, optional PIN lock with idle timeout, exfiltration guard on all outbound text

## Architecture

```
Telegram -> Grammy bot -> allowlist + PIN check
                       -> fast-path capture (INBOX.md)
                       -> Claude Agent SDK (streaming, PAI context)
                       -> exfiltration guard -> Telegram response
```

Key files:
- `src/bot.ts` — Grammy bot, message routing, streaming
- `src/agent.ts` — Claude Agent SDK bridge with retry + session resumption
- `src/capture-handler.ts` — Fast-path capture to INBOX.md, triage bridge to REVIEW.md
- `src/security.ts` — PIN lock, idle timeout, rate limiting
- `src/exfiltration-guard.ts` — Scans outbound text for secrets/paths
- `src/voice.ts` — Groq Whisper transcription
- `src/config.ts` — Environment validation
- `src/db.ts` — SQLite session persistence
- `src/queue.ts` — Per-chat sequential message queue

## Setup

```bash
bun install
cp .env.example .env   # fill in required values
bun run src/index.ts
```

### Required environment variables

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `ALLOWED_CHAT_IDS` | Comma-separated Telegram chat IDs |

### Optional environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MODEL` | `claude-sonnet-4-6` | Claude model for agent |
| `AGENT_MAX_TURNS` | `30` | Max agent tool-use turns |
| `AGENT_TIMEOUT_MS` | `900000` | Agent timeout (15min) |
| `AGENT_CWD` | `$HOME` | Working directory for agent |
| `GROQ_API_KEY` | — | Groq API key for voice transcription |
| `PIN_HASH` | — | Argon2 PIN hash (omit to disable locking) |
| `PIN_SALT` | — | Required with PIN_HASH |
| `IDLE_LOCK_MINUTES` | `30` | Auto-lock after idle period |

## Deployment

Runs as a systemd user service:

```bash
./deploy/deploy.sh          # copies service file, enables, starts
journalctl --user -u claudeclaw -f   # tail logs
```

## Development

```bash
bun run typecheck           # TypeScript check
bd ready                    # open work items
bd create --title="..."     # new task
```

### Git workflow

All changes go through pull requests — never push directly to `main`.

```bash
git checkout -b feat/my-feature
# ... make changes ...
git commit -m "feat: description"
git push -u origin HEAD
gh pr create --fill
```
