# AGENTS.md

## Read Order

1. `CLAUDE.md`
2. `AGENTS.md`
3. relevant docs
4. `bd ready`

## Workflow

- `bd ready` before choosing work
- `bd show <id>` before implementation
- `bd update <id> --claim` before starting
- `bd note <id> "..."` for shared progress
- `bd remember "..." --key <name>` for durable repo facts
- `bd close <id> --reason "..."` only on real completion

## Optional but useful

- `bd dep <blocker> --blocks <blocked>` for real sequencing
- `bd blocked` to inspect waits
- `bd prime` for session context injection
- `bd stale` to find abandoned work

## Memory Model

- Beads = task state and durable repo memory
- `main` = merged truth
- local memory/handoff files = convenience only

## Lifecycle

- claim before implementation
- note during execution
- create follow-up beads when scope expands
- close only on real completion or explicit supersession
- never auto-close on commit or session end

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
