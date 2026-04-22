# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Session Bootstrap

Read `AGENTS.md` after this file.

## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context.

```bash
bd ready              # find available work
bd show <id>          # view issue details
bd update <id> --claim  # claim work
bd close <id>         # complete work
```

Rules:
- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files
- Run `bd prime` for the full command reference

## Codebase Architecture

Full architecture is in `README.md`. Essentials:

**Stack:** Bun runtime, TypeScript, grammY (Telegram), `@anthropic-ai/claude-agent-sdk` (agent), SQLite (sessions + memory). Default to Bun, not Node.

**Request path:** `Telegram → grammY → allowlist/PIN → fast-path capture OR Claude Agent SDK (streaming) → exfiltration guard → Telegram`

**Key source files** (`src/`):
- `index.ts` — entry, initializes DBs and bot
- `bot.ts` — grammY handlers, streaming, intent routing, memory injection
- `agent.ts` — Claude Agent SDK `query()` wrapper with retry + session resumption
- `runtime-prompt.ts` — system-prompt append content for bot runs (cwd-agnostic)
- `memory.ts` — SQLite semantic memory (per-chat facts, cosine similarity, dedup)
- `extraction.ts` — fact extraction + embedding (fire-and-forget post-response)
- `capture-handler.ts` — INBOX.md capture + mx triage bridge
- `security.ts` — PIN lock, idle timeout, rate limiting
- `exfiltration-guard.ts` — secret/path scan on all outbound text
- `voice.ts` — Groq Whisper STT
- `db.ts`, `queue.ts`, `config.ts`

**Runtime prompt split:** The bot's Telegram-facing identity, PAI pipeline awareness (TELOS, mx, capture), intent routing, and security deflection rules live in `src/runtime-prompt.ts` and are appended to the Agent SDK's `systemPrompt`. This ensures those rules apply in every cwd the bot roams into via `/project`. Do NOT put runtime-only bot behavior in CLAUDE.md — it would be dropped when the agent switches projects.

**Local state:** `.claudeclaw/sessions.db` (SQLite WAL — sessions + memories tables).

**Deployment:** Systemd user service `claudeclaw.service`. Run `./deploy/deploy.sh` to update. Never run the bot manually alongside the service. Tail logs: `journalctl --user -u claudeclaw -f`.

## Development Commands

```bash
bun install                  # install deps
bun run typecheck            # tsc --noEmit — run before every commit
bun run src/index.ts         # run bot locally (requires .env)
./deploy/deploy.sh           # pull + restart systemd service
systemctl --user status claudeclaw    # service state
```

No test suite yet. Quality gate is `bun run typecheck`.

## Git Workflow — PR Only (CRITICAL)

**Never push directly to `main`.** All changes go through pull requests.

**Branch naming:** `<type>/<short-description>` — e.g. `feat/voice-v2`, `fix/daemon-node22`.

**Session close:**
1. `bd create` follow-ups for remaining work
2. `bun run typecheck` if code changed
3. Close finished `bd` issues
4. Create PR:
   ```bash
   git checkout -b <type>/<description>
   git add <files>
   git commit -m "<type>: <description>"
   git push -u origin HEAD
   gh pr create --fill
   bd dolt push
   ```
5. Merge if approved: `gh pr merge --squash`
6. Clean up: `git checkout main && git pull && git branch -d <branch>`

Rules:
- NEVER push directly to main
- Work is NOT complete until the PR is created and pushed
- Keep PRs focused — one logical change per PR


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
