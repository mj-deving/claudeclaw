# ClaudeClaw OS v2 — Complete Rebuild Blueprint

> Extracted from Mark's video demo (Early AI Dopters, April 2026), REBUILD_PROMPT_V2.md, CLAUDECLAW_ASSESSMENT_PROMPT.md, POWER_PACKS.md, and POWER_PACKS_GUIDE.md.

---

## 1. What ClaudeClaw OS Is

A personal AI operating system that runs on your local machine and lets you control Claude Code from your phone (Telegram/Discord/iMessage), a browser dashboard, and a voice room. It is **not** an API wrapper — it spawns real `claude` CLI subprocesses via Anthropic's Agent SDK, inheriting all your skills, MCP servers, and memory. The phone is just a remote control.

**Core principle:** Your Claude Code subscription powers everything. No additional API costs for the core loop. Optional add-ons (Gemini for memory, ElevenLabs for voice, Pika for meeting avatars) have generous free tiers.

---

## 2. Architecture Overview

```
User Interface (Phone / Browser / Laptop)
        |
        v
Channels:
  Telegram / WhatsApp / Slack / Discord / Dashboard :3141 / War Room :7860
        |
        v
Core Engine:
  Message Queue (FIFO per chat, prevents race conditions)
  → Security Gate (PIN lock + chat ID allowlist)
  → Message Classifier (simple vs complex routing)
  → Memory Inject (5-layer retrieval + Obsidian context)
  → Agent SDK (Claude Code subprocess, session resumption)
  → Exfiltration Guard (15+ patterns, base64/URL scanning)
  → Cost Footer (5 display modes)
  → Reply
        |
        v
5 Agents: Main, Comms, Content, Ops, Research
  <-> Hive Mind (shared activity log in SQLite)
  <-> Scheduler + Mission Control (cron + priority queue)
        |
        v
SQLite Database (WAL mode, field-level AES-256-GCM encryption)
        |
        v
Infrastructure: Mac/Linux, launchd/systemd, Node.js 20+, Python 3.10+ (War Room)
```

---

## 3. The SDK Bridge — Foundation (200 lines of code)

Everything is built on `@anthropic-ai/claude-agent-sdk@^0.2.34`. This spawns the real `claude` CLI as a subprocess.

**Key settings:**
- `permissionMode: 'bypassPermissions'` — skip tool-use confirmation prompts (no one watching the terminal)
- `resume: sessionId` — persistent context across messages (composite key: `chat_id + agent_id`)
- `settingSources: ['project', 'user']` — loads CLAUDE.md + global skills from `~/.claude/`
- `maxTurns: AGENT_MAX_TURNS` (default 30) — prevents runaway tool-use loops
- Timeout: `AGENT_TIMEOUT_MS` (default 900000 = 15 minutes)

**Core wrapper (`src/agent.ts`):**
```typescript
export interface AgentOptions {
  message: string
  sessionId?: string
  agentId?: string
  cwd?: string
  systemPrompt?: string
  onTyping?: () => void
  maxTurns?: number
}

export interface AgentResult {
  text: string | null
  newSessionId?: string
  inputTokens?: number
  outputTokens?: number
  model?: string
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult>
export async function runAgentWithRetry(opts: AgentOptions, maxRetries?: number): Promise<AgentResult>
```

`runAgentWithRetry` wraps `runAgent` with 2 retries, exponential backoff, and model fallback via `classifyError()`.

---

## 4. Modular Power Pack System

ClaudeClaw v2 is built as a core + 8 independent power packs. Install any combination.

| # | Pack | Purpose | Dependencies |
|---|------|---------|-------------|
| 1 | **Memory v2** | Semantic memory with LLM extraction | `@google/genai`, GOOGLE_API_KEY |
| 2 | **Multi-Agent** | Up to 20 specialized agents | `js-yaml`, Telegram bot tokens per agent |
| 3 | **War Room** | Real-time voice room with agents | Python 3.10+, pipecat-ai, GOOGLE_API_KEY |
| 4 | **Mission Control** | Cron scheduler + task queue | `cron-parser` |
| 5 | **Security** | PIN, kill phrase, exfiltration guard, audit | None (built-in crypto) |
| 6 | **Voice Upgrade** | STT/TTS cascades with 4 providers | GROQ_API_KEY (optional) |
| 7 | **Dashboard** | Web UI on :3141 with SSE real-time | `hono`, `@hono/node-server` |
| 8 | **Meeting Bot** | Video avatar joins calls | PIKA_DEV_KEY or RECALL_API_KEY |

**Recommended install order:** Memory v2 → Security → Multi-Agent → Mission Control → Voice → War Room → Dashboard → Meeting Bot

---

## 5. Pack 1: Memory v2

Replaces flat-text storage with a full semantic memory engine powered by Gemini.

### Ingestion Pipeline (`src/memory-ingest.ts`)
- Fire-and-forget after each response (never blocks user)
- Sends conversation to `gemini-3-flash-preview` with extraction prompt
- Returns: `{ summary, entities[], topics[], importance: 0-1, salience: 0-5 }`
- Importance threshold: only facts scoring >= 0.5 get stored
- Skip: messages < 15 chars or starting with `/`
- Truncate: 2000 chars max before sending to Gemini

### Embedding & Dedup (`src/embeddings.ts`)
- 768-dim vectors via `gemini-embedding-001`
- Cosine similarity check before insert
- Duplicate threshold: 0.85 — merges instead of creating new entry
- Storage: hex-encoded string in SQLite (or Buffer via Float32Array)

### 5-Layer Retrieval (`src/memory.ts` — `buildMemoryContext()`)
1. **Semantic search** — embedding cosine similarity, min threshold 0.3, top 5
2. **FTS5 keyword search** — full-text search on summary + raw_text, top 5
3. **Recent high-importance** — importance >= 0.7, last 48h, top 5
4. **Consolidation insights** — latest 3 consolidation records
5. **Conversation history** — keyword-triggered, 7-day window, top 10

Results deduplicated by memory ID, sorted by importance descending.

### Consolidation Engine (`src/memory-consolidate.ts`)
- Background job every 30 minutes
- Fetches up to 20 unconsolidated memories
- Sends to Gemini for pattern detection, contradiction flagging
- Returns: `{ summary, insight, connections[], contradictions[] }`
- Contradictions trigger supersession (older memory gets `superseded_by` pointer)

### Decay System
- **Pinned (pinned=1):** 0% decay — persists forever
- **High importance (>= 0.8):** salience *= 0.99/day
- **Mid importance (>= 0.5):** salience *= 0.98/day
- **Low importance (< 0.5):** salience *= 0.95/day
- **Hard delete:** when salience < 0.05

### Relevance Feedback
- Post-response, sends surfaced memories + response to Gemini
- Useful memories: salience += 0.1 (cap 5.0)
- Unused memories: salience -= 0.05 (floor 0.05)

### Memory Nudging
- Configurable intervals: `MEMORY_NUDGE_INTERVAL_TURNS=10`, `MEMORY_NUDGE_INTERVAL_HOURS=2`
- Proactively surfaces top-salience memories when thresholds crossed

### High-Importance Callback
- importance >= 0.8 triggers Telegram notification to admin chat for potential pinning

---

## 6. Pack 2: Multi-Agent System

### Agent Architecture
- Up to 20 agents, each with:
  - Own Telegram bot (separate @BotFather token)
  - Own `CLAUDE.md` personality file (resolved via `resolveAgentClaudeMd()`)
  - Own working directory (resolved via `resolveAgentDir()`)
  - Own MCP server allowlist (inline in `agent.yaml`, NOT separate JSON)
  - Session isolation via composite key `(chat_id, agent_id)`
- Default model: `claude-sonnet-4-6` (overridable per-agent)
- Agent ID regex: `/^[a-z][a-z0-9_-]{0,29}$/`
- External config at `CLAUDECLAW_CONFIG/agents/{id}/` overrides project-local `agents/{id}/`

### 5 Default Agent Templates
| Agent | GoT Persona | Role |
|-------|------------|------|
| **Main** | Hand of the King | General-purpose triage + delegation |
| **Comms** | Master of Whisperers | Email, Slack, LinkedIn, messages |
| **Content** | Royal Bard | Writing, editing, publishing, brand voice |
| **Ops** | Master of War | System admin, deployments, infrastructure |
| **Research** | Grand Maester | Deep dives, competitive analysis |

### Hive Mind
- SQLite table where agents log meaningful actions
- Schema: `agent_id, action_type, summary, metadata (JSON), created_at`
- All agents read/write same table — no API calls between them
- Example: Comms logs "Sent follow-up email to Sarah" → Main can check "did we follow up?"

### Inter-Agent Tasks
- Schema: `from_agent, to_agent, prompt, status (pending/completed), result`
- Delegation syntax: `@agentId: prompt` or `/delegate agentId prompt`

### Agent Creation Wizard (`src/agent-create.ts`, 615 lines)
1. Pick template from `agents/_template/`
2. Enter agent ID (validates regex)
3. Paste Telegram token (validates against Telegram API)
4. Set working directory, MCP allowlist, model
5. Writes `agents/{id}/agent.yaml` + `CLAUDE.md`
6. Generates launchd plist (macOS) or systemd unit (Linux)
7. Assigns color from 15-color palette for dashboard

### Orchestrator (`src/orchestrator.ts`)
```typescript
export function parseDelegation(message: string): { agentId: string; prompt: string } | null
export async function delegateToAgent(agentId: string, prompt: string, chatId: string): Promise<AgentResult>
```

---

## 7. Pack 3: War Room

Browser-based voice room on port 7860 powered by Pipecat (Python real-time voice framework).

### Two Modes
| Mode | Pipeline | Control Level |
|------|----------|--------------|
| **live** (default) | Audio → Gemini Live (speech-to-speech) → response | Low (Google handles everything) |
| **legacy** | Audio → Deepgram STT → Router → Claude Code → Cartesia TTS | High (each component tuneable) |

### Gemini Live Tool Functions (live mode)
- `delegate_to_agent(agent, title, prompt, priority)` — routes work to specific agent
- `answer_as_agent(agent, question)` — asks agent and reads response aloud
- `get_time()` — current time
- `list_agents()` — active agent roster
- **Auto-mode:** Gemini acts as router, calling `answer_as_agent` to invoke sub-agents

### Routing Rules (priority order)
1. **Broadcast triggers:** "everyone", "team", "all agents" → all agents
2. **Name prefix:** "hey Research, look into..." → that agent
3. **Pinned agent:** state at `/tmp/warroom-pin.json` → pinned agent
4. **Default:** → Main agent

### GoT-Themed Voices
| Agent | Persona | Gemini Voice | Cartesia Voice ID |
|-------|---------|-------------|-------------------|
| Main | Hand of the King | Charon | `a0e99841-...` |
| Research | Grand Maester | Kore | `79a125e8-...` |
| Comms | Master of Whisperers | Aoede | `b7d50908-...` |
| Content | Royal Bard | Leda | `c8f144b8-...` |
| Ops | Master of War | Alnilam | `726d5ae5-...` |

### Agent Voice Bridge (`src/agent-voice-bridge.ts`)
- Node.js CLI subprocess called by Python
- `--quick` flag limits to 3 turns for snappy voice responses
- `--chat-id` for session persistence across voice interactions
- Strips `CLAUDE_CODE_*` env vars to prevent nested session conflicts
- Returns JSON on stdout: `{ response, usage, error }`

### UI (`warroom/warroom-html.ts`)
- 69KB embedded HTML with cinematic boardroom intro animation
- Dark theme, agent persona cards with speaking/thinking states
- Push-to-talk and continuous listening modes
- Audio pipeline: 16kHz input, 24kHz output, protobuf serialization

### Python Dependencies
```
pipecat-ai[websocket,deepgram,cartesia,silero]==0.0.75
fastapi
uvicorn
python-dotenv
```

### Auto-Spawn
- War Room subprocess spawned from `src/index.ts` on startup (gated by `WARROOM_ENABLED=true`)
- On crash: respawn with exponential backoff (1s start, 30s max)
- On clean shutdown: SIGTERM + wait

---

## 8. Pack 4: Mission Control

### Scheduler (`src/scheduler.ts`)
- 60-second polling loop
- `resetStuckTasks()` on init — recovers tasks left in 'running' from crashes
- For each due task: lock → execute with 10-min timeout → compute next run → unlock
- Uses `cron-parser` for schedule expressions

### Mission Queue
- One-shot async tasks with priority ordering (1=highest, 5=lowest)
- Agent assignment: explicit via CLI/dashboard, or auto via Gemini classification
- Tasks processed one per tick in priority order
- Unassigned tasks (NULL `assigned_agent`) auto-classified by Gemini (cheap model)

### CLIs
- `src/schedule-cli.ts` — create, list, delete, pause, resume scheduled tasks
- `src/mission-cli.ts` — create, list, result, cancel mission tasks

---

## 9. Pack 5: Security

Single 215-line file (`src/security.ts`) + exfiltration guard.

### PIN Lock
- Salted SHA-256 hash stored as `salt:hash` in `.env`
- Verify with `crypto.timingSafeEqual()` (NOT `===`)
- Auto-lock after `IDLE_LOCK_MINUTES` (default 30) of inactivity
- Bot starts locked if `SECURITY_PIN_HASH` is set

### Emergency Kill Phrase
- Case-insensitive exact match against `EMERGENCY_KILL_PHRASE`
- Sends SIGTERM to all `com.claudeclaw.*` (macOS) or `claudeclaw-*` (Linux) services
- Force-exit after 5 seconds

### Exfiltration Guard (`src/exfiltration-guard.ts`)
15+ regex patterns scanning every outbound message:
- `sk-ant-*`, `sk-*`, `xox[bp]-*`, `ghp_*`, `gho_*`
- `AKIA*` (AWS), `AIza*` (Google), `sk_live_*`/`sk_test_*` (Stripe)
- Telegram bot tokens, Twilio `SK*`, SendGrid `SG.*`, Mailgun `key-*`
- Bearer tokens, hex strings (32+), password assignments
- **Base64-encoded** and **URL-encoded** variants of protected env values
- Private key headers (`-----BEGIN ... PRIVATE KEY-----`)
- Matches replaced with `[REDACTED]` before sending

### Audit Log
- SQLite table: `agent_id, event_type, details, chat_id, created_at`
- Event types: `message, command, delegation, unlock, lock, kill, blocked`

### Chat ID Allowlist
- Only configured `ALLOWED_CHAT_ID` can interact with the bot
- All other chat IDs get rejected

---

## 10. Pack 6: Voice Upgrade

Single 504-line file (`src/voice.ts`) handling both STT and TTS cascades.

### STT Cascade
1. **Groq Whisper** (primary) — `whisper-large-v3`, free tier, `GROQ_API_KEY`
2. **whisper-cpp** (fallback) — local binary, no API key, always works

Note: `.oga` files renamed to `.ogg` before sending to Groq (format requirement).

### TTS Cascade
1. **ElevenLabs** — `eleven_turbo_v2_5`, highest quality, supports voice cloning
2. **Gradium** — EU servers, 45K free monthly credits, `GRADIUM_API_KEY`
3. **Kokoro** — any OpenAI-compatible TTS server at `KOKORO_URL`, zero cost, fully offline
4. **macOS `say`** (or Linux `espeak`) — last resort, always works

Each provider implements the same interface. On failure/timeout, cascade to next automatically.

---

## 11. Pack 7: Dashboard

Web UI served by Hono on port 3141, protected by token auth (`?token=`).

### Stack
- Backend: Hono + `@hono/node-server` (1,370 lines in `src/dashboard.ts`)
- Frontend: Single embedded HTML/CSS/JS (3,200+ lines in `src/dashboard-html.ts`)
- Charts: Chart.js loaded from CDN
- Real-time: Server-Sent Events via `chatEvents` EventEmitter
- No build step, no React, no external frontend dependencies

### Tabs
1. **Overview** — stats cards + 7-day token chart
2. **Conversation** — live message log via SSE
3. **Memory** — searchable timeline with importance bars, entities as tags, pinned status
4. **Tokens** — 30-day usage bar chart, per-agent breakdown
5. **Audit** — filterable log table, blocked actions in red
6. **Agents** — status cards with color, online/offline dot, model override, creation wizard
7. **Tasks** — scheduled (cron) + missions (priority queue) with status badges
8. **Hive Mind** — cross-agent activity feed

### Features
- Privacy blur toggle (CSS blur on sensitive data)
- Agent creation wizard from dashboard
- Model override picker per agent
- War Room management (start, pin agent, voice catalog)
- Mission task creation and auto-assignment
- Serves War Room HTML at `/warroom` route
- Optional Cloudflare Tunnel for remote access
- Dark theme (background `#0a0a0f`, cards `#1a1a2e`, accent `#E07A4F`)

### API Endpoints
```
GET  /                      → Dashboard SPA
GET  /api/health            → { status, uptime, version }
GET  /api/memories          → Memory list (filtered by agent_id, limit)
GET  /api/tokens            → Token usage stats (last 30 days)
GET  /api/hive-mind         → Recent hive mind entries
GET  /api/audit-log         → Audit entries (filtered)
GET  /api/agents            → Agent configs + status
GET  /api/tasks             → Scheduled + mission tasks
GET  /api/events            → SSE stream
POST /api/mission/create    → Create mission task
POST /api/mission/:id/assign → Assign agent
GET  /api/warroom/start     → Start War Room subprocess
POST /api/warroom/pin       → Pin agent in War Room
```

---

## 12. Pack 8: Meeting Bot

**Maturity: Experimental**

### Pre-Flight Briefing (75-second budget)
1. **Step 1 (30s):** Parallel fetch — Calendar (next 24h), Gmail (30 days per attendee), Memory
2. **Step 2 (30s):** Gemini compresses into briefing card (< 500 words)
3. **Step 3 (15s):** Feed briefing to agent via voice bridge

### Meeting Join
- **Pika provider:** Video avatar generation (~$0.275/min), lip-synced with TTS audio
- **Recall.ai provider:** Voice-only (cheaper alternative)
- Browser automation joins Google Meet or Zoom
- Real-time transcription during call
- Post-meeting summary with action items sent to Telegram

### Files
- `src/meet-cli.ts` (792 lines) — join, leave, list subcommands
- `skills/pikastream-video-meeting/SKILL.md` — skill definition
- Session tracking in `meet_sessions` table

---

## 13. Message Flow Pipeline

Detailed flow when a message arrives from Telegram:

```
1. Telegram message arrives
2. isAuthorised(chatId) — check ALLOWED_CHAT_ID
3. enqueue(chatId, task) — FIFO per chat, prevents race conditions
4. checkKillPhrase(text) — if match, executeEmergencyKill()
5. isLocked() — if locked, check if PIN entry → unlock() or reject
6. classifyMessage(text) — simple vs complex routing
7. buildMemoryContext(chatId, text) — 5-layer retrieval
8. buildObsidianContext(text, vaultPath) — inject relevant vault notes
9. Prepend memory + obsidian context to message
10. getSession(chatId, agentId) — resume existing session
11. Start typing indicator refresh (every 4s)
12. runAgentWithRetry({ message, sessionId, agentId, maxTurns: 30 })
    → Spawns real claude CLI subprocess via Agent SDK
13. Save new sessionId if changed
14. saveConversationTurn() — fire-and-forget memory ingestion
15. evaluateMemoryRelevance() — fire-and-forget relevance feedback
16. logToHiveMind() — if multi-agent, log activity
17. scanForSecrets(response) — exfiltration guard, redact if needed
18. formatCostFooter() — append usage info (5 modes)
19. If voice mode: synthesizeSpeech(response) → send audio
20. Else: formatForTelegram(response) → splitMessage() → send HTML chunks
21. resetIdleTimer() — reset security auto-lock
```

---

## 14. Complete File Structure

### Always Created (Core)
```
src/
  index.ts            — Entry point, lifecycle, lock file, War Room auto-spawn
  agent.ts            — Claude Code SDK wrapper (runAgent, runAgentWithRetry)
  agent-config.ts     — agent.yaml loader, resolveAgentDir, resolveAgentClaudeMd
  db.ts               — SQLite schema + ALL queries (2,400+ lines)
  config.ts           — 46+ env var loader, setAgentOverrides
  env.ts              — .env parser (no process.env pollution)
  logger.ts           — pino + pino-pretty setup
  bot.ts              — Telegram/Discord/iMessage handler (1,500+ lines)
  state.ts            — In-memory state, abort controllers, SSE events
  message-queue.ts    — FIFO per-chat queue
  errors.ts           — Error classification with retry policies
  cost-footer.ts      — 5-mode cost display (compact/verbose/cost/full/off)
  message-classifier.ts — Simple vs complex routing
  hooks.ts            — Pre/post message hooks
  rate-tracker.ts     — Daily/hourly budget tracking
  oauth-health.ts     — Token expiry monitoring
  skill-health.ts     — Skill invocation testing
  skill-registry.ts   — Auto-discovery of Claude Code skills
  obsidian.ts         — Vault context builder

scripts/
  setup.ts            — Interactive setup wizard (44.6KB)
  status.ts           — Health check
  agent-create.sh     — Agent creation wrapper
  agent-service.sh    — Service management
  install-launchd.sh  — macOS service installer
  notify.sh           — Send Telegram/Discord message from shell

store/                — Runtime data (gitignored)
workspace/uploads/    — Temp media downloads (gitignored)
CLAUDE.md             — System prompt template
.env.example          — All config keys with explanations
package.json / tsconfig.json / .gitignore
```

### Conditional Files
```
Memory v2:
  src/memory.ts             — 5-layer retrieval, decay, pinning, nudging
  src/memory-ingest.ts      — Gemini extraction, importance scoring, dedup
  src/memory-consolidate.ts — 30-min background consolidation
  src/embeddings.ts         — Gemini 768-dim embeddings + cosine similarity
  src/gemini.ts             — Gemini API wrapper

Memory simple:
  src/memory.ts             — Last N turns from SQLite

Voice:
  src/voice.ts              — 504 lines, STT + TTS cascades
  src/media.ts              — Telegram file download + context building

WhatsApp:
  src/whatsapp.ts           — WhatsApp Web.js bridge

Multi-Agent:
  src/orchestrator.ts       — Agent delegation, @agent: syntax, hive mind
  src/agent-create.ts       — 615-line creation wizard
  src/agent-create-cli.ts   — CLI wrapper
  agents/_template/         — CLAUDE.md + agent.yaml templates
  agents/{name}/            — Per-agent configs

War Room:
  warroom/server.py         — Pipecat voice server (dual-mode)
  warroom/router.py         — Agent routing (broadcast, name, pinned)
  warroom/personas.py       — GoT personas + system prompts
  warroom/agent_bridge.py   — Python → Node subprocess bridge
  warroom/config.py         — Project root resolver, constants
  warroom/voices.json       — Voice ID mappings per agent
  warroom/client.js         — Pipecat browser client
  warroom/client.bundle.js  — esbuild bundle
  warroom/requirements.txt  — Python dependencies
  src/agent-voice-bridge.ts — Node CLI bridge for voice
  src/warroom-html.ts       — 69KB cinematic UI

Scheduler:
  src/scheduler.ts          — 60s polling loop
  src/schedule-cli.ts       — CLI for task management

Mission Control:
  src/mission-cli.ts        — One-shot task management

Security:
  src/security.ts           — PIN, idle lock, kill phrase, audit (215 lines)
  src/exfiltration-guard.ts — 15+ secret detection patterns

Dashboard:
  src/dashboard.ts          — Hono server + REST API (1,370 lines)
  src/dashboard-html.ts     — Embedded SPA (3,200+ lines)

Meeting Bot:
  src/meet-cli.ts           — PikaStream meeting join (792 lines)
  skills/pikastream-video-meeting/SKILL.md

Slack:
  src/slack.ts              — @slack/web-api wrapper
```

---

## 15. Complete SQLite Schema

All tables use WAL mode (`PRAGMA journal_mode = WAL`). Inline migrations via `PRAGMA table_info()` checks.

### Always Present

```sql
-- Session persistence (composite key for multi-agent isolation)
CREATE TABLE sessions (
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, agent_id)
);

-- Full conversation log
CREATE TABLE conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT DEFAULT 'main',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Token usage tracking
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT DEFAULT 'main',
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL,
  created_at INTEGER NOT NULL
);

-- Skill health tracking
CREATE TABLE skill_health (...);
CREATE TABLE skill_usage (...);
CREATE TABLE session_summaries (...);
CREATE TABLE compaction_events (...);
```

### Memory v2
```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT DEFAULT 'main',
  source TEXT,
  raw_text TEXT,
  summary TEXT,
  entities TEXT,        -- JSON array
  topics TEXT,          -- JSON array
  connections TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  salience INTEGER NOT NULL DEFAULT 0,
  consolidated INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,       -- 768-dim float32 buffer
  superseded_by INTEGER,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);

-- FTS5 for keyword search (content columns ONLY to avoid write amplification)
CREATE VIRTUAL TABLE memories_fts USING fts5(
  summary, raw_text, content=memories, content_rowid=id
);

-- Triggers restricted to content columns only
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, raw_text) VALUES (new.id, new.summary, new.raw_text);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text) VALUES ('delete', old.id, old.summary, old.raw_text);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF summary, raw_text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text) VALUES ('delete', old.id, old.summary, old.raw_text);
  INSERT INTO memories_fts(rowid, summary, raw_text) VALUES (new.id, new.summary, new.raw_text);
END;

CREATE TABLE consolidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  insight TEXT,
  connections TEXT,
  contradictions TEXT,
  source_memory_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### Memory Simple
```sql
CREATE TABLE turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### Multi-Agent
```sql
CREATE TABLE hive_mind (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata TEXT,         -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_hive_agent_time ON hive_mind(agent_id, created_at);

CREATE TABLE inter_agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

### Scheduler / Mission Control
```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,     -- cron expression
  next_run INTEGER NOT NULL,
  last_run INTEGER,
  last_result TEXT,
  priority INTEGER NOT NULL DEFAULT 3,
  agent_id TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','paused','running','completed','failed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_due ON scheduled_tasks(status, priority, next_run);

CREATE TABLE mission_tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

### Security
```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  details TEXT,
  chat_id TEXT,
  created_at INTEGER NOT NULL
);
```

### War Room
```sql
CREATE TABLE warroom_transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  speaker TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### Meeting Bot
```sql
CREATE TABLE meet_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_url TEXT NOT NULL,
  meeting_title TEXT,
  briefing TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  platform TEXT,          -- 'google_meet' or 'zoom'
  provider TEXT DEFAULT 'pika',  -- 'pika' or 'recall'
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
```

### WhatsApp / Slack
```sql
-- WhatsApp: wa_messages, wa_outbox, wa_message_map
-- Slack: slack_messages
-- Both use field-level AES-256-GCM encryption for message content
```

---

## 16. All Dependencies

### Core (always required)
```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.2.34",
  "better-sqlite3": "latest",
  "pino": "latest",
  "pino-pretty": "latest",
  "grammy": "latest"
}
```

### Conditional
| Feature | Package | Version |
|---------|---------|---------|
| Discord | `discord.js` | latest |
| Slack | `@slack/web-api` | latest |
| STT (OpenAI) | `openai` | latest |
| Scheduler | `cron-parser` | latest |
| WhatsApp | `whatsapp-web.js`, `qrcode-terminal` | latest |
| Multi-Agent | `js-yaml`, `@types/js-yaml` | latest |
| Memory v2 | `@google/genai` | ^1.44.0 |
| Dashboard | `hono`, `@hono/node-server` | ^4.0.0, ^1.0.0 |
| War Room (Python) | `pipecat-ai[websocket,deepgram,cartesia,silero]` | 0.0.75 |
| War Room (Python) | `fastapi`, `uvicorn`, `python-dotenv` | latest |

### Dev
```json
{
  "typescript": "latest",
  "tsx": "latest",
  "@types/better-sqlite3": "latest",
  "@types/node": "latest",
  "esbuild": "latest"
}
```

---

## 17. All Environment Variables

### Required
| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Main bot token from @BotFather |
| `ALLOWED_CHAT_ID` | Your Telegram chat ID (bot tells you on first message) |

### Memory v2
| Variable | Purpose | Default |
|----------|---------|---------|
| `GOOGLE_API_KEY` | Gemini extraction + embeddings + War Room | — |
| `MEMORY_NUDGE_INTERVAL_TURNS` | Turns between memory nudges | 10 |
| `MEMORY_NUDGE_INTERVAL_HOURS` | Hours between memory nudges | 2 |

### Voice
| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | Groq Whisper STT (free tier) |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS |
| `ELEVENLABS_VOICE_ID` | Voice to use |
| `GRADIUM_API_KEY` | Gradium TTS backup |
| `GRADIUM_VOICE_ID` | Voice ID (default: alloy) |
| `GRADIUM_MODEL` | Model (default: default) |
| `KOKORO_URL` | Local TTS server (default: localhost:8880) |
| `KOKORO_VOICE` | Voice (default: af_heart) |
| `KOKORO_MODEL` | Model (default: kokoro) |
| `WHISPER_MODEL_PATH` | Path to whisper-cpp model file |

### Security
| Variable | Purpose | Default |
|----------|---------|---------|
| `SECURITY_PIN_HASH` | `salt:hash` format PIN | — |
| `IDLE_LOCK_MINUTES` | Auto-lock timeout | 30 |
| `EMERGENCY_KILL_PHRASE` | Kill phrase text | — |

### Multi-Agent
| Variable | Purpose |
|----------|---------|
| `{AGENT_ID}_TELEGRAM_TOKEN` | Per-agent Telegram bot tokens |
| `CLAUDECLAW_CONFIG` | External config dir (default: `~/.claudeclaw`) |

### War Room
| Variable | Purpose | Default |
|----------|---------|---------|
| `WARROOM_ENABLED` | Enable War Room | false |
| `WARROOM_MODE` | "live" or "legacy" | live |
| `WARROOM_PORT` | Port | 7860 |
| `DEEPGRAM_API_KEY` | Deepgram STT (legacy mode) | — |
| `CARTESIA_API_KEY` | Cartesia TTS (legacy mode) | — |

### Dashboard
| Variable | Purpose | Default |
|----------|---------|---------|
| `DASHBOARD_TOKEN` | Auth token for web UI | — |
| `DASHBOARD_PORT` | Port | 3141 |

### Meeting Bot
| Variable | Purpose |
|----------|---------|
| `PIKA_DEV_KEY` | Pika video avatar generation |
| `RECALL_API_KEY` | Recall.ai voice-only alternative |

### Core Config
| Variable | Purpose | Default |
|----------|---------|---------|
| `AGENT_MAX_TURNS` | Max tool-use turns per message | 30 |
| `AGENT_TIMEOUT_MS` | Agent timeout | 900000 (15 min) |
| `SHOW_COST_FOOTER` | Footer mode | compact |
| `STREAM_STRATEGY` | Streaming mode | off |
| `LOG_LEVEL` | Pino log level | info |

---

## 18. Setup Flow

### Fresh Build (15 minutes)
1. Paste REBUILD_PROMPT_V2.md into Claude Code in an empty directory
2. Answer 6 preference questions (platform, voice, memory, features, multi-agent, advanced)
3. Run setup wizard — collects API keys for selected features only
4. Wizard installs background service (launchd/systemd)
5. Done

### Existing Install (Power Packs)
1. Run CLAUDECLAW_ASSESSMENT_PROMPT.md to audit current state
2. Pick Power Packs from POWER_PACKS.md
3. Paste each pack prompt into Claude Code inside the ClaudeClaw directory
4. Each pack reads existing code and adds the feature non-destructively

### Prerequisites
- Mac or Linux (Windows: manual service setup)
- Node.js 20+
- Python 3.10+ (only for War Room)
- `claude` CLI installed and logged in
- Telegram account (@BotFather for bot token)

---

## 19. Key Design Decisions

1. **Single SQLite database** — All data in one WAL-mode DB. No external databases. Inline migrations via `PRAGMA table_info()` checks.
2. **No separate API route files** — Dashboard API, dashboard HTML, voice, security — each is a single large file. Simplifies deployment.
3. **Fire-and-forget memory ingestion** — Never blocks the user response. Errors logged silently.
4. **Composite session keys** — `(chat_id, agent_id)` ensures multi-agent session isolation.
5. **Agent SDK, not API** — Spawns real `claude` process, inherits all skills/MCP/memory. Not an API wrapper.
6. **`fileURLToPath(import.meta.url)`** — Path resolution everywhere. Never `new URL().pathname` (breaks on spaces).
7. **No process.env pollution** — Custom `.env` parser (`src/env.ts`), reads into local variables.
8. **agent.yaml for config** — MCP allowlists inline in agent.yaml, not separate JSON files.
9. **External config support** — `CLAUDECLAW_CONFIG` (~/.claudeclaw) overrides project-local agent configs.
10. **Field-level AES-256-GCM** — WhatsApp and Slack message content encrypted at rest.

---

## 20. Source Attribution

| Source | Content |
|--------|---------|
| YouTube video `rVzGu5OYYS0` | Live demo of War Room, Mission Control, agent delegation, dashboard, memory timeline, Telegram interaction. Explains the "why" — using existing Claude subscription, modular design, no vendor lock-in. |
| `REBUILD_PROMPT_V2.md` (~1900 lines) | Complete build specification. TLDR, knowledge base (Q&A), 6-question preference collector, architecture overview, full file structure, detailed specs for every file with TypeScript interfaces and SQL schemas. |
| `CLAUDECLAW_ASSESSMENT_PROMPT.md` (~185 lines) | Audit checklist for existing installations. Lists every v2 feature with checkboxes for scanning. |
| `POWER_PACKS.md` (~815 lines) | 8 executable prompts — paste-and-go code generation for each feature pack. |
| `POWER_PACKS_GUIDE.md` (~460 lines) | Companion guide explaining each pack's purpose, implementation details, dependencies, and inter-pack connections. |
