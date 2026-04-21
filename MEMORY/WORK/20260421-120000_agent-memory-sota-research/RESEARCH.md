# Agent Memory Architecture: SOTA Research for ClaudeClaw

> Deep research into best-practice agent memory systems. Synthesized from 4 parallel research agents covering 60+ sources across academic papers, production frameworks, and OpenClaw deployment patterns we documented.
> Date: 2026-04-21

---

## Table of Contents

1. [The Emerging Consensus Architecture](#1-the-emerging-consensus-architecture)
2. [OpenClaw Patterns (From Our Deployment Runbook)](#2-openclaw-patterns)
3. [Framework Deep Dives](#3-framework-deep-dives)
4. [The Six Gaps: Mapped to SOTA Solutions](#4-the-six-gaps)
5. [The Roaming Agent Problem](#5-the-roaming-agent-problem)
6. [Framework Comparison Matrix](#6-framework-comparison-matrix)
7. [Recommended Architecture for ClaudeClaw v2](#7-recommended-architecture)
8. [Implementation Priority Roadmap](#8-implementation-priority-roadmap)
9. [Sources](#9-sources)

---

## 1. The Emerging Consensus Architecture

The field has converged on a four-layer model. Every production system maps to some subset of this:

```
Layer 1: In-Context Memory (per-session, ephemeral)
├── System prompt + project instructions (CLAUDE.md)
├── FIFO message buffer with summarization on eviction
└── Working scratchpad for current task state

Layer 2: Project-Scoped Persistent Memory (per-repo)
├── Markdown instruction files (git-tracked, team-shared)
├── Auto-memory file (machine-local, grows organically)
└── Vector index of codebase (semantic search over project files)

Layer 3: User-Scoped Cross-Project Memory (per-user)
├── Personal preferences, coding style, tooling choices
├── Workflow patterns, debugging approaches
└── Vector + optional graph store, queryable across projects

Layer 4: Organizational / Global Memory (per-org)
├── Shared conventions, security policies, architecture decisions
├── Knowledge base entries (extracted wisdom)
└── Composed with user memory during retrieval
```

**Retrieval**: Scoped composition — query hits user + project + global scopes simultaneously. Results ranked by recency × relevance × access frequency.

**Writes**: Async-first — extract facts after response delivery. LLM-based ADD/UPDATE/DELETE/NOOP decision. Background refinement during idle periods.

---

## 2. OpenClaw Patterns (From Our Deployment Runbook)

> Note: openclaw-bot is our personal deployment runbook for OpenClaw, not an official repo. These are patterns we documented from deploying and configuring the OpenClaw framework.

### 2.1 Lossless Claw (LCM)

The flagship memory innovation. A DAG-based context persistence plugin that solves the token-waste problem of TTL-based context pruning.

**Architecture (5 Layers):**

| Layer | Function |
|-------|----------|
| Persistence | All messages stored in SQLite, never discarded |
| Fresh Tail | Recent 32 messages protected from summarization |
| Incremental Compaction | Async compression forming DAG at depth levels D0→D1→D2→D3 |
| Context Assembly | Combines raw recent + compressed historical within 128K budget |
| Retrieval Tools | 4 tools for agent-driven DAG navigation |

**The DAG Structure:**
- **D0 (minutes)**: Specific decisions, rationale, technical details
- **D1 (hours)**: Arc distillation — outcomes, evolution, current state
- **D2 (days)**: Durable narrative — decisions in effect, milestone timeline
- **D3 (weeks)**: Higher-level compression for long-running conversations

**Key Design Choices:**
- Cost optimization: Summarization routed to Haiku, session stays on Sonnet
- Session filtering via glob patterns (cron jobs marked stateless)
- Large file handling: 3-segment sampling (beginning + middle + end)
- DB: SQLite at `~/.openclaw/lcm.db` with optional FTS5

**Retrieval Tools:**
- `lcm_describe` — subtree inspection
- `lcm_grep` — cross-depth search
- `lcm_expand` — drill-down into specific nodes
- `lcm_expand_query` — smart retrieval with subagent

### 2.2 Built-in Memory (Three-Tier)

**Tier 1: Vector + FTS5 (Primary)**
- SQLite at `~/.openclaw/memory/main.sqlite`
- Embeddings: `embeddinggemma-300m` (local, 384-dim, zero cloud dependency)
- Hybrid search: 0.7 vector weight + 0.3 BM25 text weight
- Optional MMR deduplication, temporal decay (30-day half-life)
- Chunking: ~400 tokens with ~80-token overlap, semantic boundaries

**Tier 2: Pre-Compaction Flush**
- Triggers before context overflow (~176K tokens)
- LLM extracts lasting notes to `memory/daily/YYYY-MM-DD.md`
- Near-zero cost (implicit in regular operation)

**Tier 3: PARA Structure**
```
memory/
  daily/            # Raw daily logs (today + yesterday auto-loaded)
  projects/         # Active goals with deadlines (HOT)
  areas/            # Ongoing responsibilities (WARM)
  resources/        # Reference material (WARM)
  archive/          # Completed/inactive (COLD)
  meta/             # Consolidation state & scores
  MEMORY.md         # Curated long-term
```

**Consolidation Crons (~$1.18/month total):**
| Cron | Schedule | Purpose | Cost |
|------|----------|---------|------|
| Nightly | Daily 3AM | Extract facts → route to PARA | ~$0.90/mo |
| Weekly | Sunday 3AM | Dedup, update importance scores, archive stale | ~$0.20/mo |
| Monthly | 1st of month | Compress old daily files into monthly summaries | ~$0.08/mo |

**FadeMem Decay Pattern:**
- Important facts get consolidated forward by crons (resetting freshness → stays "alive")
- Unimportant facts age out via `halfLifeDays: 30`
- Result: 82.1% critical fact retention at 55% storage

### 2.3 Atlas Forge Three-Tier Memory

From the Jarvis bundle analysis, a production agent running 24/7:

| Tier | Retention | Consolidation |
|------|-----------|---------------|
| Constitutional | Never expires | Manual review only |
| Strategic | ~90 days | Quarterly review |
| Operational | 30-day auto-decay | Nightly extraction → promotion |

**Boot Sequence (order matters):**
1. SOUL.md → identity
2. USER.md → who you're helping
3. SECURITY.md → prompt injection defense
4. HANDOFF.md → last session state
5. memory/YYYY-MM-DD.md (today + yesterday)
6. MEMORY.md (main session only)

**Extended Mind Philosophy**: Files ARE the cognitive system (Clark & Chalmers). Six principles from Alzheimer's caregiving: identity anchoring, temporal grounding, relationship context, preference knowledge, task continuity, immediate actionability.

### 2.4 PAI Pipeline (Cross-Agent)

Filesystem-based cross-agent delegation with project routing:

```
/var/lib/pai-pipeline/
├── tasks/           # Gregor → Isidore (forward)
├── results/         # Isidore → Gregor (results)
├── reverse-tasks/   # Isidore → Gregor (reverse delegation)
├── workflows/       # Multi-step workflow state
└── artifacts/       # Shared build artifacts
```

Task JSON includes `"project"` field for cwd resolution. Supports `--session` for session resumption.

---

## 3. Framework Deep Dives

### 3.1 MemGPT / Letta — Virtual Memory for LLMs

**Core concept**: LLM context window = RAM, external storage = disk. Agent manages its own memory via function calls.

**Three Tiers:**

| Tier | Analogy | Storage | Capacity | Access |
|------|---------|---------|----------|--------|
| Core Memory | RAM | In-context blocks | ~5K chars/block | Always visible |
| Archival Memory | Disk (structured) | Vector DB | Unlimited | `archival_memory_search(query)` |
| Recall Memory | Disk (raw) | Conversation log | Unlimited | `conversation_search(query)` |

**Core Memory** is composed of labeled `Block` objects. Agent edits via `core_memory_append(label, content)` and `core_memory_replace(label, old, new)`. Total must fit in context.

**Heartbeat mechanism**: Tool calls include `request_heartbeat: true` for chained operations — search → read → update core → respond in one turn.

**Sleep-time compute**: Async "memory agents" refine memory during idle periods. Proactive, not reactive.

**Letta Context Repositories** (newer): Git-backed memory filesystems. Each subagent gets its own git worktree. Memory conflicts resolved via git merge. A `system/` directory designates always-loaded files.

**Memory defragmentation**: Background subagent splits large files, merges duplicates, restructures into 15-25 focused files.

### 3.2 Zep / Graphiti — Temporal Knowledge Graphs

**Architecture**: G = (N, E, φ) with three subgraph tiers:

**Episode Subgraph (Ge)**: Raw messages preserved verbatim. Non-lossy data store. Episodic edges connect to extracted entities for bidirectional tracing.

**Semantic Entity Subgraph (Gs)**: Entities extracted, resolved against existing graph, embedded in 1024D (BGE-m3). Relationships as subject-predicate-object triples.

**Community Subgraph (Gc)**: Strongly connected clusters with summarizations. Label propagation for dynamic community detection.

**Entity Resolution Pipeline (5 stages):**
1. Named entity recognition (current + 4 prior messages)
2. Embedding to 1024D vectors
3. Cosine + full-text candidate identification
4. LLM comparison for duplicate detection
5. Predefined Cypher queries for schema-consistent integration

**Bi-Temporal Model** — two timelines per edge:
- **Timeline T** (chronological): `t_valid` → `t_invalid`
- **Timeline T'** (transactional): `t_created` → `t_expired`
- When facts contradict: old edge's `t_invalid` set to new edge's `t_valid`

**Retrieval: f(α) = χ(ρ(φ(α))) = β**
- **Search φ**: cosine similarity, BM25, breadth-first n-hop traversal
- **Reranking ρ**: RRF, MMR, episode-frequency, node-distance, cross-encoder
- **Constructor χ**: Format into context strings with temporal validity

**Performance**: 115K token conversations → 1.6K average context. P95 latency 300ms. +18.5% accuracy over full-context on LongMemEval.

### 3.3 Mem0 — Scoped Memory Composition

**Five scoping dimensions** that compose during retrieval:
```
user_id    → Personal memories across all projects
org_id     → Organizational knowledge
session_id → Current task context (ephemeral)
agent_id   → Per-agent instance isolation
app_id     → Per-application separation
```

**Three memory types**: Episodic (events), Semantic (knowledge), Procedural (workflows).

**Extraction pipeline**:
1. LLM analyzes conversation with semantic history summary
2. Candidate facts identified
3. Top-k similar existing memories retrieved
4. LLM decides: ADD / UPDATE / DELETE / NOOP

**Performance**: Vector-only 0.71s p95, 66.9% accuracy, 1800 tokens/conversation. Graph-enhanced (Mem0g) 2.59s p95, 68.4% accuracy.

**Key insight**: Selective memory achieves 91% lower latency and 90% fewer tokens versus full-context at ~8% accuracy cost. The tradeoff is almost always worth it.

### 3.4 Git Context Controller (GCC)

Oxford research, +13.6% on SWE-Bench Verified. Four operations:

| Operation | Function |
|-----------|----------|
| COMMIT | Convert transient reasoning → persistent memory |
| BRANCH | Create isolated execution space |
| MERGE | Synthesize divergent reasoning paths with origin annotations |
| CONTEXT | Multi-level retrieval with windowed projection |

**Structure**: `.GCC/main.md` (shared roadmap), `branches/<name>/` with `commit.md`, `log.md`, `metadata.yaml`.

**Theoretical max**: 3,276,800 tokens (100 archived branches × 32,768 window).

### 3.5 CrewAI — Composite Scoring

The most concrete pruning formula found:

```
composite = 0.5 × similarity + 0.3 × decay + 0.2 × importance
```

Where:
- `similarity = 1 / (1 + distance)` from vector index
- `decay = 0.5 ^ (age_days / half_life_days)` (default 30 days)
- `importance` = 0-1 score assigned by LLM during encoding
- Consolidation threshold: 0.85 similarity triggers dedup
- Batch dedup: 0.98 cosine similarity drops near-duplicates

### 3.6 Codex CLI — Citation Tracking

Two-phase background consolidation:
1. Phase 1: Extract structured summaries from `.jsonl` rollout logs
2. Phase 2: Merge into `memory_summary.md` (injected, capped 5K tokens) + searchable `MEMORY.md`

**Citation tracking**: `usage_count` and `last_usage` timestamps. Memories that get cited survive longer. Automated pruning of Phase 1 outputs older than `max_unused_days`.

### 3.7 MemoryOS (Academic, EMNLP 2025)

Three-level hierarchical storage inspired by OS memory management:

| Level | Capacity | Eviction |
|-------|----------|----------|
| Short-Term (STM) | 7 dialogue pages | FIFO → Mid-Term |
| Mid-Term (MTM) | Segmented by topic | Heat-based → Long-Term |
| Long-Term Persona (LPM) | Persistent | Never (user characteristics) |

**Heat-based promotion**: `Heat = α × N_visit + β × L_interaction + γ × R_recency`. Threshold τ=5 triggers promotion from MTM to LPM.

**Performance**: 49.11% F1 improvement over baselines. Only 4.9 LLM calls vs A-Mem's 13.

---

## 4. The Six Gaps: Mapped to SOTA Solutions

### Gap 1: No Memory Cap / No Pruning

**Current state**: Memories grow forever. Linear scan loads ALL embeddings per chat.

**SOTA solutions**:

| Approach | Framework | Implementation |
|----------|-----------|----------------|
| Composite scoring + decay | CrewAI | `0.5*sim + 0.3*decay + 0.2*importance`, 30-day half-life |
| Citation tracking | Codex CLI | `usage_count`, `last_usage` — cited memories survive longer |
| TTL + LRU | Mem0 | Native TTL, delete-oldest policies |
| Importance-modulated retention | OpenClaw/FadeMem | Important facts consolidated forward, unimportant age out |
| Heat-based promotion | MemoryOS | Visit frequency + interaction length + recency |
| Temporal invalidation | Zep | Bi-temporal model — contradicting facts mark old as invalid |

**Recommendation for ClaudeClaw**: Implement CrewAI's composite scoring with Codex-style citation tracking. On each memory retrieval, increment `usage_count`. On pruning pass (daily cron or on-store), score all memories and drop those below threshold. Cap at ~500 memories per chat with soft eviction.

### Gap 2: No Cross-Chat Memory

**Current state**: Memories scoped to `chat_id`. Multiple Telegram chats = isolated memory.

**SOTA solutions**:

| Approach | Framework | Implementation |
|----------|-----------|----------------|
| Scoped composition | Mem0 | user_id + org_id + session_id compose during retrieval |
| Cross-thread Store | LangGraph | Namespace-based store shared across threads |
| PARA structure | OpenClaw | `memory/` directory shared across sessions |
| Global auto-memory | Claude Code | `~/.claude/projects/<project>/memory/` shared across sessions |

**Recommendation for ClaudeClaw**: Add a `user_id` scope alongside `chat_id`. Store memories at two levels — chat-scoped (local context) and user-scoped (cross-chat). Retrieval merges both: `SELECT ... WHERE chat_id = ? OR scope = 'user'`. User-scoped memories are facts that matter everywhere (preferences, patterns). Chat-scoped memories are conversation-specific.

### Gap 3: No Manual Save (`/remember`)

**Current state**: Only auto-extraction from conversations. No way to explicitly save a fact.

**SOTA solutions**:

| Approach | Framework | Implementation |
|----------|-----------|----------------|
| `core_memory_append` | MemGPT/Letta | Agent calls function to save to core memory |
| `archival_memory_insert` | MemGPT/Letta | Agent saves to long-term vector store |
| `remember()` API | CrewAI | Programmatic memory write with LLM-inferred metadata |
| MEMORY.md manual edits | Claude Code | User directly edits memory file |
| `bd remember` | Beads | CLI command for durable cross-session facts |

**Recommendation for ClaudeClaw**: Add `/remember <fact>` command. Embed the fact, store with `source: 'manual'` and `importance: 1.0` (manual saves get max importance, never auto-pruned). Also add `/search <query>` for semantic memory search from Telegram.

### Gap 4: FTS5 Unused

**Current state**: FTS5 virtual table created, triggers maintained, but `searchMemories` only uses cosine similarity.

**SOTA solutions**:

| Approach | Framework | Weight |
|----------|-----------|--------|
| Hybrid search | OpenClaw | 0.7 vector + 0.3 BM25 |
| Triple search | Zep/Graphiti | cosine + BM25 + breadth-first graph traversal |
| RRF fusion | Zep | Reciprocal Rank Fusion to merge ranked lists |

**Recommendation for ClaudeClaw**: Implement hybrid search. When querying, run both cosine similarity AND FTS5 `MATCH` query. Score: `0.7 * cosine_score + 0.3 * bm25_score`. This catches cases where semantic meaning is similar but exact keywords differ (cosine wins) and where the user is looking for a specific term (FTS wins).

### Gap 5: Silent Failures

**Current state**: If Gemini embedding fails, the entire memory path silently skips.

**SOTA solutions**:

| Approach | Framework | Implementation |
|----------|-----------|----------------|
| Embedding fallback chain | OpenClaw | Local → OpenAI → Gemini (auto-selected) |
| Actor-aware tagging | Mem0 | Source tracking: user statement vs agent inference |
| Error surfacing | General best practice | Log + optional user notification |

**Recommendation for ClaudeClaw**: 
1. Add a fallback embedding: if Gemini fails, try a local model or skip with a console warning
2. Add a `/memorystatus` command that shows: total memories, last extraction time, last failure, embedding model health
3. Track `last_extraction_success` and `last_extraction_failure` timestamps in the DB
4. If 3+ consecutive failures, append a footer to the next response: "⚠️ Memory offline"

### Gap 6: No Bridge to Knowledge Base (kn)

**Current state**: SQLite memories and `~/.claude/knowledge/entries/` markdown files are completely separate.

**SOTA solutions**:

| Approach | Framework | Implementation |
|----------|-----------|----------------|
| PARA routing | OpenClaw | Nightly cron extracts → routes to projects/areas/resources |
| Context Repositories | Letta | Git-backed memory files, searchable |
| MCP memory server | Memorix/LORE | Shared memory accessible to any MCP agent |
| Knowledge graph | Zep/Graphiti | Entities and relationships extracted, graph-queryable |
| Trigger tables | Codified Context paper | File patterns → specialized agents with domain knowledge |

**Recommendation for ClaudeClaw**: Create a `/kn search <query>` command that embeds the query and searches kn entries via filename matching + content grep. For deeper integration, add a nightly cron that:
1. Scans memories with `usage_count > 3` and `importance > 0.7`
2. Checks if a related kn entry exists (by semantic similarity to entry titles)
3. If yes, appends the memory as a "related insight" to the kn entry
4. If no, flags for potential new kn entry creation

---

## 5. The Roaming Agent Problem

### 5.1 The Use Case

ClaudeClaw is a Telegram bot that wraps Claude Code. The user switches dynamically between:
- Multiple projects (`~/projects/*`)
- Git branches within those projects
- Bead branches (issue tracker state)
- Upstream GitHub repos

The agent needs to maintain useful context across all of this.

### 5.2 Current Industry State

**No agent natively scopes memory per-branch.** The universal pattern is worktree isolation (each branch gets its own agent session in its own directory). The closest production solution is Claude Code's third-party Branch Memory Manager using git post-checkout hooks.

**Branch context merge at git merge time is completely unsolved** across the entire industry. When feature-branch knowledge merges into main, the knowledge disappears.

**Fork/upstream awareness is entirely human-curated.** No agent tracks fork relationships. Workaround: document upstream conventions in AGENTS.md/CLAUDE.md.

**Cross-project pattern transfer** ("you used this pattern in project A, try it here") — only Augment Code attempts it via proprietary cross-repo index. No open-source solution.

### 5.3 Best Practices for Context Switching

**GCC Pattern (best academic approach):**
- COMMIT current context before switching
- CONTEXT to load target project's state
- BRANCH for isolated work
- MERGE to synthesize when returning

**OpenClaw PAI Pipeline (best production approach):**
- Project field in task JSON routes to correct cwd
- Session IDs enable long-running project work
- Filesystem-based delegation with group permissions

**Beads (our advantage):**
- Issue state as queryable long-term memory (cited by Better Stack as a model)
- `bd compact` implements agentic memory decay
- Task graphs stored as versioned JSONL in git — naturally branches with code

### 5.4 Recommended Pattern for ClaudeClaw

```
On project switch (/project <name>):
1. COMMIT: Save current project context snapshot
   - Active bead issues for this project
   - Recent memory facts tagged to this project
   - Current branch and uncommitted work summary
2. SWITCH: Load target project context
   - Read project's CLAUDE.md
   - Load project-scoped memories (tag: project=<name>)
   - Load active beads for target project
3. INJECT: Prepend project context to next agent message

On git branch switch (detected via project cwd):
1. Note branch name in memory metadata
2. Filter memories by branch tag when relevant
3. On merge: no automatic context merge (matches industry state)

Cross-project insights:
1. User-scoped memories (scope='user') are always available
2. kn entries are global — wisdom extracted from any project searchable everywhere
3. `/remember` facts default to user scope unless tagged to a project
```

---

## 6. Framework Comparison Matrix

| Framework | Memory Persistence | Cross-Project | Pruning/Decay | Knowledge Graph | Context Switch | Embedding |
|-----------|-------------------|---------------|---------------|-----------------|----------------|-----------|
| **ClaudeClaw** (current) | SQLite + embeddings | No | No | No | Project command | Gemini 768d |
| **OpenClaw** | SQLite + FTS5 + PARA MD | Workspace-scoped | FadeMem 30d half-life | No | Memory Wiki |  embeddinggemma 384d |
| **MemGPT/Letta** | 3-tier (core/recall/archival) | Context Repos (git) | Agent-managed | Via Graphiti | Git worktrees | Configurable |
| **Zep/Graphiti** | Temporal knowledge graph | Multi-source fusion | Bi-temporal invalidation | Core feature | Temporal reconstruction | BGE-m3 1024d |
| **Mem0** | Vector + graph store | 5-scope composition | TTL, LRU, LLM pruning | Mem0g graphs | Scope switching | Configurable |
| **CrewAI** | LanceDB + SQLite | Hierarchical scope paths | Composite scoring | No | MemorySlice | text-embedding-3-small |
| **Codex CLI** | JSONL + consolidated MD | Per-session threads | TTL + citation tracking | No | Session files | — |
| **Claude Code** | Markdown files | Per-git-repo | Compaction + 200-line cap | No | Worktree-shared | — |
| **GCC** | Git-versioned MD | Shared roadmap | Windowed context budgets | No | BRANCH/MERGE/CONTEXT | — |
| **Cursor** | .cursor/rules MDC | No | No | No | Project rules | — |
| **Cline** | Markdown Memory Bank | MCP server | No | No | Manual context files | — |
| **Aider** | None (fresh each session) | None | N/A | No | N/A | — |

### Embedding Model Comparison

| Model | Dimensions | Code-Specific | Cost | Context | Best For |
|-------|------------|---------------|------|---------|----------|
| **voyage-code-3** | 2048/1024/512/256 | Yes (+13.8% vs OpenAI) | Free first 200M tokens | 32K | Code retrieval |
| **Gemini text-embedding-004** | 768 | No | Free (1500 RPM) | — | Budget fallback |
| **text-embedding-3-small** | 1536 | No | $0.02/1M tokens | 8K | General purpose |
| **BGE-m3** | 1024 | No | Free (local) | — | Graph memory |
| **embeddinggemma-300m** | 384 | No | Free (local) | — | Privacy-first |

---

## 7. Recommended Architecture for ClaudeClaw v2 Memory

Based on all research, here's the proposed architecture:

```
┌──────────────────────────────────────────────────────┐
│                   ClaudeClaw v2 Memory                │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Layer 1: Working Memory (per-message)               │
│  ├── Embed user query (voyage-code-3 or Gemini)      │
│  ├── Hybrid search: 0.7 cosine + 0.3 FTS5 BM25      │
│  ├── Scope composition: chat + user + project        │
│  └── Inject [Memory context] into agent message      │
│                                                      │
│  Layer 2: Chat Memory (per-chat, auto)               │
│  ├── SQLite: memories table (existing)               │
│  ├── + scope column: 'chat' | 'user' | 'project'    │
│  ├── + project_id column: nullable project name      │
│  ├── + importance: 0.0-1.0 (LLM-assigned)           │
│  ├── + usage_count, last_used timestamps             │
│  ├── Composite scoring for retrieval ranking         │
│  └── Async extraction after response (existing)      │
│                                                      │
│  Layer 3: User Memory (cross-chat, persistent)       │
│  ├── Same SQLite table, scope='user'                 │
│  ├── /remember <fact> → manual save, importance=1.0  │
│  ├── /search <query> → semantic search from Telegram │
│  ├── /memory → show recent (existing)                │
│  └── /memorystatus → health check                    │
│                                                      │
│  Layer 4: Knowledge Base Bridge (global)             │
│  ├── /kn search <query> → grep kn entries            │
│  ├── Nightly cron: promote high-use memories → kn    │
│  └── kn entries searchable from Telegram             │
│                                                      │
│  Pruning Layer (background)                          │
│  ├── Composite score: 0.5*sim + 0.3*decay + 0.2*imp │
│  ├── 30-day half-life exponential decay              │
│  ├── Citation tracking: used memories survive longer │
│  ├── Cap: ~500 memories per chat, soft eviction      │
│  ├── Manual saves (importance=1.0) never auto-pruned │
│  └── Daily cron or on-store trigger                  │
│                                                      │
│  Resilience Layer                                    │
│  ├── Embedding fallback: Gemini → local → skip+warn  │
│  ├── Failure tracking: consecutive_failures counter  │
│  ├── User notification: "⚠️ Memory offline" footer   │
│  └── /memorystatus for diagnostics                   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Schema Changes (Minimal, Additive)

```sql
-- Add columns to existing memories table
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE memories ADD COLUMN project_id TEXT;
ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_used TEXT;

-- Index for scoped queries
CREATE INDEX idx_memories_scope ON memories(scope, chat_id);
CREATE INDEX idx_memories_project ON memories(project_id);
```

### What We DON'T Need (Yet)

- **Knowledge graph (Zep/Graphiti)**: Overkill for current scale. Revisit when memory count > 10K or cross-project entity resolution becomes important.
- **MemGPT-style agent-managed memory**: Our current auto-extraction pattern works. Agent-managed adds complexity without clear benefit at our scale.
- **LCM/Lossless Claw**: ClaudeClaw delegates to Claude Code which handles its own context. LCM solves a problem we don't have in the Telegram bot layer.
- **PARA structure**: Our kn entries and TELOS already serve this purpose. Don't duplicate.

---

## 8. Implementation Priority Roadmap

### P0: Quick Wins (1-2 hours each)

1. **`/remember <fact>`** — Manual save command. Embed, store with `source='manual'`, `importance=1.0`.
2. **Hybrid search** — Add FTS5 BM25 query alongside cosine. Merge with 0.7/0.3 weighting.
3. **Silent failure fix** — Wrap embedding calls with error tracking. Add `last_failure` timestamp. Log warnings.

### P1: Memory Maturity (half-day each)

4. **Scope & importance columns** — Schema migration. Add `scope`, `project_id`, `importance`, `usage_count`, `last_used`.
5. **Cross-chat memory** — `/remember` facts default to `scope='user'`. Auto-extracted facts stay `scope='chat'`. Retrieval merges both.
6. **`/search <query>`** — Semantic memory search from Telegram. Returns top 5 with similarity scores.
7. **`/memorystatus`** — Show total count, last extraction, last failure, embedding health.

### P2: Intelligence Layer (1-2 days)

8. **Composite scoring** — Implement `0.5*sim + 0.3*decay + 0.2*importance` for retrieval ranking.
9. **Citation tracking** — On each memory retrieval, increment `usage_count` and update `last_used`.
10. **Pruning cron** — Daily pass: score all memories, soft-evict below threshold, hard cap at 500/chat.
11. **Embedding upgrade** — Evaluate voyage-code-3 vs current Gemini. Switch if latency acceptable.

### P3: Knowledge Bridge (1 day)

12. **`/kn search <query>`** — Grep kn entry filenames + content from Telegram.
13. **Memory → kn promotion** — Flag high-use, high-importance memories for kn entry creation.

### P4: Roaming Agent (future)

14. **Project-scoped memories** — Tag memories with `project_id` on project switch. Filter retrieval by active project + user scope.
15. **Branch awareness** — Track current branch in memory metadata. Informational only (no branch-scoped isolation — matches industry state).
16. **Context snapshot on project switch** — Save/load project context summaries.

---

## 9. Sources

### Academic Papers
- MemGPT (arxiv 2310.08560) — Virtual context management for LLMs
- Zep/Graphiti (arxiv 2501.13956) — Temporal knowledge graph architecture
- MemoryOS (arxiv 2506.06326, EMNLP 2025) — OS-inspired personal agent memory
- Git Context Controller (arxiv 2508.00031) — Git operations for agent context, +13.6% SWE-Bench
- Codified Context (arxiv 2602.20478) — Three-tier codified context architecture
- FadeMem (Jan 2026) — Importance-modulated retention with decay

### Production Frameworks
- Letta/MemGPT: docs.letta.com — Context Repositories, sleep-time compute
- Zep: zep.ai — Bi-temporal graphs, Graphiti engine
- Mem0: mem0.ai — Scoped composition, State of AI Agent Memory 2026
- CrewAI: docs.crewai.com — Composite scoring formula
- LangGraph: docs.langchain.com — Checkpointing, cross-thread Store
- OpenAI Codex CLI: deepwiki.com/openai/codex — Citation tracking, consolidation

### Developer Agent Documentation
- Claude Code: code.claude.com — Memory hierarchy, auto-memory, CLAUDE.md
- Cursor: cursor.com — Background Agents, worktrees, .cursor/rules
- Aider: aider.chat — Git-aware but no persistent memory
- Cline: cline.bot — Memory Bank, new_task tool
- Continue.dev: docs.continue.dev — Context providers
- Amazon Q: docs.aws.amazon.com — Memory Bank, workspace context
- Augment Code: augmentcode.com — Cross-repo Context Engine, MCP

### Our Ecosystem
- openclaw-bot (our deployment runbook): Reference/CONTEXT-ENGINEERING.md — LCM deep dive
- openclaw-bot (runbook): Reference/MEMORY-PLUGIN-RESEARCH.md — mem0 evaluation, PARA decision
- openclaw-bot (runbook): Reference/ATLASFORGE-PATTERNS.md — Jarvis bundle, Extended Mind
- openclaw-bot (runbook): Reference/PAI-PIPELINE.md — Cross-agent architecture
- openclaw-bot (runbook): Reference/DATABASE-MAINTENANCE.md — SQLite maintenance

### Industry Analysis
- Better Stack: beads issue tracker as agent memory model
- Martin Fowler: Context Engineering for Coding Agents
- Addy Osmani: Code Agent Orchestra
- Anthropic: 2026 Agentic Coding Trends Report
- Augment Code: Agent Memory vs Context Engineering
