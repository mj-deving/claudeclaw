---
task: Deep research on agent memory best practices
slug: 20260421-120000_agent-memory-sota-research
effort: deep
phase: complete
progress: 42/42
mode: interactive
started: 2026-04-21T12:00:00Z
updated: 2026-04-21T12:45:00Z
---

## Context

Deep research into state-of-the-art agent memory architectures, specifically targeting the six gaps identified in ClaudeClaw's current semantic memory implementation: no memory cap/pruning, no cross-chat memory, no manual save command, unused FTS5 index, silent failures, and no bridge to the kn knowledge base. Research covers 15+ frameworks across academic papers, production systems, and our own OpenClaw ecosystem. Use case: a roaming Telegram-based agent switching dynamically between projects, git branches, bead branches, and upstream GitHub repos while maintaining cross-context for daily usage.

### Risks
- Research scope is massive — risk of breadth over depth (mitigated by 4 parallel specialist agents)
- Some frameworks are marketing-heavy with thin implementation details (mitigated by source credibility assessment)
- Our use case (Telegram bot wrapping Claude Code) is unusual — most research targets IDE-embedded agents

## Criteria

- [x] ISC-1: OpenClaw lossless claw (LCM) architecture documented
- [x] ISC-2: OpenClaw PARA memory structure documented
- [x] ISC-3: OpenClaw consolidation crons documented
- [x] ISC-4: Atlas Forge three-tier memory pattern documented
- [x] ISC-5: MemGPT/Letta three-tier architecture documented
- [x] ISC-6: Letta Context Repositories (git-backed) documented
- [x] ISC-7: Zep/Graphiti temporal knowledge graph documented
- [x] ISC-8: Zep bi-temporal model documented
- [x] ISC-9: Zep retrieval architecture documented
- [x] ISC-10: LangGraph checkpointing system documented
- [x] ISC-11: LangGraph cross-thread Store interface documented
- [x] ISC-12: Mem0 scoped memory composition documented
- [x] ISC-13: CrewAI composite scoring formula documented
- [x] ISC-14: Codex CLI memory consolidation pipeline documented
- [x] ISC-15: Claude Code native memory hierarchy documented
- [x] ISC-16: GCC COMMIT/BRANCH/MERGE/CONTEXT operations documented
- [x] ISC-17: FadeMem dual-layer decay pattern documented
- [x] ISC-18: MemoryOS three-level hierarchy documented
- [x] ISC-19: Cross-project memory patterns documented
- [x] ISC-20: Branch-scoped context approaches documented
- [x] ISC-21: Session resumption three-layer model documented
- [x] ISC-22: Fork/upstream awareness gap documented
- [x] ISC-23: Issue tracker as memory (Beads) documented
- [x] ISC-24: Embedding model comparison for code documented
- [x] ISC-25: "Lossless" memory approaches documented
- [x] ISC-26: Cross-repo knowledge graph options documented
- [x] ISC-27: MCP-based cross-agent memory sharing documented
- [x] ISC-28: Daily driver / life OS memory patterns documented
- [x] ISC-29: Memory pruning/decay strategies compared
- [x] ISC-30: Database architecture consensus documented
- [x] ISC-31: Gap 1 (no memory cap) — recommendations mapped
- [x] ISC-32: Gap 2 (no cross-chat memory) — recommendations mapped
- [x] ISC-33: Gap 3 (no manual save) — recommendations mapped
- [x] ISC-34: Gap 4 (FTS unused) — recommendations mapped
- [x] ISC-35: Gap 5 (silent failures) — recommendations mapped
- [x] ISC-36: Gap 6 (no kn bridge) — recommendations mapped
- [x] ISC-37: Emerging consensus architecture synthesized
- [x] ISC-38: Framework comparison matrix delivered
- [x] ISC-39: Implementation priority roadmap proposed
- [x] ISC-40: Architecture decision for ClaudeClaw v2 memory proposed
- [x] ISC-41: Source credibility assessment included
- [x] ISC-42: Research saved to MEMORY/WORK directory

## Decisions

- Research-only deliverable — no implementation in this session
- Four parallel research agents: OpenClaw explorer, SOTA frameworks, MemGPT/Zep deep dive, git-context patterns
- Deep effort tier selected for ultrathink request

## Verification

Research findings cross-referenced across 4 independent research agents covering 60+ sources.
