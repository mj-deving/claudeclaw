# ClaudeClaw Mobile Capture Layer — Design Spec

**Date:** 2026-04-20
**Status:** Draft
**Author:** mj-deving
**Related beads:** `96d` (ClaudeClaw Memory v2), `odi` (Daemon Phase 1: TELOS Router), `2kx` (PAI Daemon epic)

---

## 1. Problem

ClaudeClaw is a Telegram bot that runs a full Claude Agent SDK session ($0.05–0.50, 5–60s latency) for every message. The user wants to use it as a mobile information dump — paste URLs, thoughts, article snippets from their phone and have them land in PAI's mx inbox. Running a full agent session for a file append is like taking a taxi to your own mailbox.

## 2. Insight

Capture and conversation are fundamentally different operations:

| Operation | Needs LLM? | Cost | Latency | Example |
|-----------|-----------|------|---------|---------|
| **Capture** | No | $0 | <1s | "https://arxiv.org/abs/2406.01234" |
| **Conversation** | Yes | $0.05–0.50 | 5–60s | "Summarize this paper and compare to our approach" |

mx already has classification (`detectType`: regex) and storage (`appendFileSync` to IDEAS.md). The TELOS Router (bead `odi`) will add tagging via keyword match. None of these need an LLM.

## 3. Architecture

```
Phone (Telegram)
    │
    ▼
ClaudeClaw (Grammy bot)
    │
    ├─── Fast Path ($0, <1s) ────────────────────────┐
    │    Trigger: /add, /url, /memo, /remind,         │
    │    or bare URL auto-detected                    │
    │                                                  ▼
    │                                          capture-handler.ts
    │                                              │
    │                                              ├→ classify (regex)
    │                                              ├→ store (append to IDEAS.md)
    │                                              ├→ tag (TELOS keyword match)*
    │                                              └→ reply "✓ Captured: ..."
    │
    └─── Agent Path ($0.05–0.50, 5–60s) ─────────────┐
         Trigger: everything else                      │
         (conversation, questions, complex tasks)      ▼
                                                  agent.ts (existing)
                                                  runAgentWithRetry()
```

*\*TELOS tagging depends on bead `odi` (Daemon Phase 1). Until built, capture works without tags.*

## 4. Fast Path Design

### 4.1 Command Detection

New function in `bot.ts` — runs before the agent path:

```typescript
function isCaptureCommand(text: string): { type: "add" | "url" | "memo" | "remind"; payload: string } | null {
  // Explicit commands
  if (text.startsWith("/add "))    return { type: "add",    payload: text.slice(5).trim() };
  if (text.startsWith("/url "))    return { type: "url",    payload: text.slice(5).trim() };
  if (text.startsWith("/memo "))   return { type: "memo",   payload: text.slice(6).trim() };
  if (text.startsWith("/remind ")) return { type: "remind", payload: text.slice(8).trim() };

  // Auto-detect: bare URL with no surrounding text → capture as URL
  const trimmed = text.trim();
  if (/^https?:\/\/\S+$/.test(trimmed)) return { type: "url", payload: trimmed };

  return null; // → agent path
}
```

**Design choices:**
- Explicit commands (`/add`, `/url`, `/memo`, `/remind`) for intentional capture
- Bare URLs auto-captured — the 80% mobile use case is pasting a link from the share sheet
- Everything else falls through to the agent path — no ambiguity
- A URL with surrounding text (e.g., "check out https://... it's interesting") goes to agent path, not capture, because the user is starting a conversation

### 4.2 Capture Handler

New file: `src/capture-handler.ts`

```typescript
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const IDEAS_FILE = join(
  process.env.HOME ?? "/home/mj",
  ".claude/PAI/USER/TELOS/IDEAS.md"
);

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function detectTag(text: string): string {
  if (/^https?:\/\//.test(text.trim())) return "[URL] ";
  if (text.length > 80) return "[MEMO] ";
  return "";
}

export interface CaptureResult {
  success: boolean;
  line: string;
  error?: string;
}

export function capture(
  type: "add" | "url" | "memo" | "remind",
  payload: string
): CaptureResult {
  try {
    // Ensure directory exists
    const dir = dirname(IDEAS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let line: string;
    if (type === "remind") {
      // Default: +7 days
      const byDate = new Date();
      byDate.setDate(byDate.getDate() + 7);
      const by = byDate.toISOString().split("T")[0];
      line = `- [${today()}] [REMIND by:${by}] ${payload}`;
    } else {
      const tag = type === "url" ? "[URL] "
                : type === "memo" ? "[MEMO] "
                : detectTag(payload);
      line = `- [${today()}] ${tag}${payload}`;
    }

    appendFileSync(IDEAS_FILE, line + "\n");
    return { success: true, line };
  } catch (err) {
    return {
      success: false,
      line: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

**This is intentionally a near-copy of `mx-lib/capture.ts`.** Why not import mx directly?
- ClaudeClaw is a separate project (`~/projects/claudeclaw`) with its own `package.json`
- mx lives at `~/.claude/tools/mx.ts` — not a proper package, no exports
- Cross-project import creates a fragile coupling that breaks if either moves
- The capture logic is 30 lines — duplication is cheaper than abstraction here

### 4.3 Bot Integration

Modification to `bot.ts` — add capture check before the agent handler:

```typescript
import { capture } from "./capture-handler.ts";

// In the message handler, before enqueue:
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  // Fast path: capture commands bypass agent entirely
  const cmd = isCaptureCommand(text);
  if (cmd) {
    const result = capture(cmd.type, cmd.payload);
    if (result.success) {
      await ctx.reply(`✓ Captured: ${result.line}`);
    } else {
      await ctx.reply(`✗ Capture failed: ${result.error}`);
    }
    return; // Skip agent path
  }

  // Agent path (existing)
  enqueue(chatId, async () => {
    await handleMessage(ctx, chatId, text);
  });
});
```

### 4.4 Systemd Constraint

The current service has `ProtectHome=read-only` with limited `ReadWritePaths`:

```ini
ReadWritePaths=__PROJECT__ __HOME__/.claudeclaw
```

IDEAS.md lives at `~/.claude/PAI/USER/TELOS/IDEAS.md` — outside the write zone. Fix:

```ini
ReadWritePaths=__PROJECT__ __HOME__/.claudeclaw __HOME__/.claude/PAI/USER/TELOS
```

**This is the narrowest scope that works.** Don't open `~/.claude` broadly — only the TELOS directory where IDEAS.md lives.

## 5. Telegram UX

### Commands to register with BotFather

```
add - Capture an idea, URL, or memo
url - Capture a URL
memo - Capture a longer note
remind - Set a reminder (default +7 days)
status - Show PAI status (via agent)
ideas - Show inbox (via agent)
lock - Lock session
unlock - Unlock session
```

### User flow examples

**Dump a URL (fastest path — zero commands):**
```
User: https://arxiv.org/abs/2406.01234
Bot:  ✓ Captured: - [2026-04-20] [URL] https://arxiv.org/abs/2406.01234
```

**Dump a thought:**
```
User: /add explore vector search for kn semantic retrieval
Bot:  ✓ Captured: - [2026-04-20] explore vector search for kn semantic retrieval
```

**Set a reminder:**
```
User: /remind review ClaudeClaw capture metrics
Bot:  ✓ Captured: - [2026-04-20] [REMIND by:2026-04-27] review ClaudeClaw capture metrics
```

**Conversation (unchanged):**
```
User: What are the open beads in Pai-Exploration?
Bot:  [full agent response, $0.12, 8s]
      📊 In: 12,340 | Out: 890 | $0.1234
```

## 6. Future: TELOS Router Integration

When bead `odi` (Daemon Phase 1) is built, the capture handler gains tagging:

```typescript
import { telosRoute } from "./telos-router.ts"; // future

export function capture(type, payload): CaptureResult {
  // ... existing classify + store logic ...

  // After store, tag (non-blocking — tagging failure doesn't block capture)
  try {
    const tags = telosRoute(payload); // returns e.g. ["G1", "S1"]
    if (tags.length > 0) {
      // Append tags to the line in IDEAS.md or log for later
    }
  } catch { /* silent — capture succeeded, tagging is bonus */ }
}
```

The full pipeline becomes:

```
Phone → Telegram → ClaudeClaw → capture-handler → IDEAS.md
                                                      │
                                          TELOS Router (keyword match)
                                                      │
                                              Tagged inbox: → G1, S1
                                                      │
                                          Daemon Phase 2 (weekly digest)
                                                      │
                                          Daemon Phase 3 (→ kn promotion)
```

## 7. What This Does NOT Include

- **Voice/audio capture** — bead `5hv` (ClaudeClaw Voice STT via Groq Whisper) is separate. When built, voice messages would be transcribed first, then fed into this same capture path.
- **Image/screenshot capture** — future. Would need OCR or vision model before capture.
- **Smart classification** — the fast path uses regex, not LLM. If you want "save this article about harness engineering for the beliefs file", that's the agent path — and the agent already has access to mx via tools.
- **Bidirectional sync** — ClaudeClaw writes to IDEAS.md. It doesn't read it back. `mx ideas` and `mx status` are CLI-only for now. Adding `/ideas` and `/status` as Telegram commands would go through the agent path.
- **Memory v2 integration** — bead `96d` (extraction + semantic search) is orthogonal. Capture goes to IDEAS.md; memory extraction happens from conversation history. Different data flows.

## 8. Implementation Estimate

| Task | LOC | Time |
|------|-----|------|
| `capture-handler.ts` | ~40 | 15 min |
| `isCaptureCommand()` in `bot.ts` | ~15 | 10 min |
| Bot handler rewire (fast path before agent path) | ~20 | 10 min |
| Systemd `ReadWritePaths` update | 1 line | 5 min |
| BotFather command registration | manual | 5 min |
| Test: send URLs, /add, /memo, /remind from phone | — | 15 min |
| **Total** | ~75 | ~1 hour |

## 9. Success Criteria

1. Bare URL sent from phone → captured in IDEAS.md in <1 second, $0 cost
2. `/add <thought>` → captured with correct date and type tag
3. `/remind <text>` → captured with +7d date
4. Regular conversation messages → still go through agent path unchanged
5. Systemd service restarts cleanly with new ReadWritePaths
6. No regression in existing agent functionality (PIN lock, exfiltration guard, session resumption)
