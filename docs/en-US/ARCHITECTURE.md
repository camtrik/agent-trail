# Architecture

agent-trail is a **two-process local application**: a Hono ingest service that watches local JSONL session files and indexes them into SQLite, and a Next.js frontend that consumes that data through a thin BFF (backend-for-frontend) proxy. This document explains the layout of the system, the boundaries between services, and the key invariants that hold them together.

For end-to-end data movement (file → DB → UI), see [`DATA-FLOW.md`](DATA-FLOW.md). For the SQLite contract, see [`db-schema.md`](db-schema.md). For per-service implementation details, see [`services/ingest.md`](services/ingest.md) and [`services/frontend.md`](services/frontend.md).

---

## 1. System overview

```text
┌──────────────────────────────────────── developer's machine ─────────────────────────────────────────┐
│                                                                                                       │
│   On-disk session sources                                                                             │
│   ────────────────────────                                                                            │
│   ~/.openclaw/agents/{name}/sessions/*.jsonl                                                          │
│   ~/.claude/projects/{encoded-cwd}/{uuid}.jsonl                                                       │
│   ~/.codex/sessions/**/*.jsonl                                                                        │
│                                                       │                                               │
│                          (chokidar watch + 15-min consistency resync)                                 │
│                                                       ▼                                               │
│   ┌───────────────────────────  Ingest service (Hono on :8078) ────────────────────────────────┐    │
│   │                                                                                              │    │
│   │   discovery → parser → sync (skip cache + transactional write) → SQLite (data/ingest.db)    │    │
│   │                                                                  │                           │    │
│   │   REST  : /api/v1/sources, /sessions, /sessions/:id, /turns, /messages, /lookup            │    │
│   │   SSE   : /api/v1/events, /api/v1/sessions/:id/events                                       │    │
│   │   Health: /health, /version                                                                  │    │
│   └───────────────────────────────────────────┬───────────────────────────────────────────────┘    │
│                                               │ HTTP / SSE (only on localhost)                       │
│   ┌───────────────────────────  Next.js frontend (port :3029) ───────────────────────────────┐     │
│   │                                                                                            │     │
│   │   BFF proxy (D-07): app/api/agent-tools/[tool]/{health,sessions,sync,events,...}          │     │
│   │     - validates [tool] (assertSourceToolId)                                                │     │
│   │     - injects source=[tool] into ingest queries                                            │     │
│   │     - caps limit at 100                                                                    │     │
│   │     - sanitizes errors (502 generic message)                                               │     │
│   │                                                                                            │     │
│   │   Shell + per-tool pages: app/(tool-shell)/[tool]/{dashboard,sessions,activity}           │     │
│   │   Replay UI: components/replay/* (turn timeline, tool/skill/subagent/system blocks)        │     │
│   │   Zustand stores: stores/{ui,replay,tool,theme,ingest-health,office-layout}                │     │
│   └────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Both services are **plain Node.js processes** started by `concurrently` from `pnpm dev`. There is no container, no message bus, no external database.

---

## 2. Why two services?

The split is intentional and load-bearing.

| Concern | Frontend (Next.js) | Ingest (Hono) |
| --- | --- | --- |
| **Restart cost** | Slow (full Next compile) | Fast (`tsx watch`) |
| **Process model** | Per-request handlers | Long-lived: file watcher, SSE subscribers, prepared statements |
| **Hot reload behavior** | Re-renders React tree | Re-establishes file watcher + DB connection |
| **Deps** | React, Tailwind, shadcn | better-sqlite3 (native), chokidar |
| **Failure mode** | Stale UI, recoverable | Stops indexing — but UI degrades gracefully via the ingest-health overlay |

If the frontend imported parsers and the watcher directly, every UI hot reload would tear down the chokidar watcher and force a full re-scan. The split keeps ingest stable across UI churn and isolates better-sqlite3 (a native module) from Next's bundler.

---

## 3. Service boundaries

### 3.1 BFF proxy is the only path frontend → ingest (D-07)

The frontend **never** calls the ingest service directly. Every request flows through `app/api/agent-tools/[tool]/...`. This is a hard rule, enforced by code review and called out in [`lib/agent-tools/server-adapter.ts`](../lib/agent-tools/server-adapter.ts).

The BFF gives us four properties for free:

1. **Source scoping.** The `[tool]` URL segment is the trust boundary. `assertSourceToolId(tool)` rejects anything that isn't `openclaw`, `claude-code`, `codex`, or `opencode` with a 400. The adapter then injects `source=<tool>` into the ingest query — caller-supplied `source` is intentionally ignored (`buildSourceScopedSessionParams` deletes it).
2. **Cross-source isolation.** `getSourceScopedSession` reads the session and verifies `session.source === source` before returning anything; child resources (`/messages`, `/turns`) call `requireSourceScopedSession` first, so a Codex client can't fetch an OpenClaw session by guessing its ID.
3. **Limit capping.** The BFF caps `limit` at 100 even though ingest allows up to 1000. UI lists never need more than that and we don't want browser tabs allocating multi-MB JSON blobs.
4. **Error sanitization.** `sanitizeError` strips stack traces, internal paths, and ingest internals before responding. Anything we can't classify becomes `{ error: "Ingest service unreachable", code: 502 }`. Validation errors keep their HTTP status (400 / 404).

`/api/agent-tools/[tool]/events` is the SSE pass-through. It opens a `fetch` to `/api/v1/events` (or `/api/v1/sessions/:id/events`) on the ingest side and pipes the body straight to the browser, with `runtime = 'nodejs'` and `dynamic = 'force-dynamic'` so Next doesn't try to cache or buffer the stream.

### 3.2 Per-tool routing (D-08)

Three tools share the same shell (`app/(tool-shell)/[tool]/`) and the same BFF dispatch table:

```ts
const adapters: Record<string, AgentToolServerAdapter> = {
  openclaw: openclawAdapter,
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  qoder: qoderAdapter,
  commandcode: commandcodeAdapter,
}
```

Adapters are pure dispatch — no `if (toolId === 'openclaw')` branches in route handlers. The only tool-conditional code in the BFF is the OpenClaw-only Gateway lookup at `/api/agent-tools/[tool]/sessions/lookup` (per D-10).

The aggregate scope, `all`, is a synthetic aggregate view — it is not an ingest source. `assertSourceToolId` rejects `all`; it's only accepted by the wider `assertAgentToolId` used by the shell layout.

### 3.3 Trust boundaries summarised

| Boundary | Validator | Responds with |
| --- | --- | --- |
| `[tool]` URL segment (BFF) | `assertSourceToolId` (or `assertAgentToolId` for shell) | 400 on unknown tool |
| `sessionId` URL segment (BFF) | `validateSessionId` (regex `^[a-zA-Z0-9:\-_.]{1,256}$`) | 400 on bad format |
| `sessionId` URL segment (ingest) | Same regex applied independently | 400 on bad format |
| `?source=` (ingest) | Whitelist `['openclaw', 'claude-code', 'codex', 'opencode']` | 400 on unknown source |
| `?role=` (ingest `/messages`) | Whitelist `['user', 'assistant', 'system', 'tool_result']` | 400 on bad role |
| `?sort=` / `?order=` (ingest) | Whitelist `updated_at` / `started_at` / `ended_at` × `asc` / `desc` | 400 on bad sort |
| `limit` / `offset` | Non-negative integers; `limit` capped at 1000 (ingest) / 100 (BFF) | 400 on negative |
| Source path discovery | `isWithinRoot` (resolved absolute paths) | Path filtered out + warning |

---

## 4. The canonical trace contract

Everything in the system speaks one shape, defined in [`types/trace.ts`](../types/trace.ts):

```text
TraceSource           = 'openclaw' | 'claude-code' | 'codex' | 'opencode' | 'qoder' | 'commandcode'
TraceSession          { id, source, project, name?, startedAt, endedAt, status, metrics, ... }
TraceTurn             { id, sessionId, index, userMessage, assistantMessages[], activities[], ... }
TraceMessage          { id, ordinal, role, content, timestamp?, model?, tokenUsage?, sourceMetadata }
TraceActivity         = TraceToolCall | TraceSkillUse | TraceSubagentLink | TraceThinkingBlock | TraceSystemEvent
TraceToolCall         { id, name, category, inputJson, status, resultEvents[], durationMs?, messageOrdinal? }
```

**Why a turn-first model?** A turn is the user's mental unit ("one round of asking and getting a response"). Raw messages would force the UI to do the grouping every render. The turn assembler runs once per session view, on demand.

The contract is consumed by:

- Parsers — they emit `ParseResult { session, messages[], activities[], errors[] }` (see [`ingest/parser/types.ts`](../ingest/parser/types.ts)).
- Sync layer — writes the contract into SQLite (see [`db-schema.md`](db-schema.md) for the table mapping).
- Turn assembler — reads `messages` and `tool_calls` rows and produces `TraceTurn[]` at query time.
- BFF + UI — the JSON returned by the BFF is exactly the canonical shape; no re-mapping in React.

Source-specific shape lives in the parsers; everything downstream sees the canonical model only.

---

## 5. Read model: why SQLite, why turns-on-demand

JSONL files are great for AI tools to write and bad for UIs to read:

- Filtering "all sessions touching project X, sorted by recency" requires reading every file.
- Pagination across hundreds of sessions requires sorting in memory each time.
- Subagent relationships span multiple files.

So we materialize a **read model** in `data/ingest.db` (SQLite, WAL mode):

- `sessions` — one row per session file, indexed on `(source, project)`, `started_at`, parent / root for subagents.
- `messages` — flat ordered messages per session, primary lookup `(session_id, ordinal)`.
- `tool_calls` + `tool_result_events` — tool invocations linked to messages.
- `turns` — pre-computable turn rows (currently always re-assembled from messages on read; the table exists for future caching).
- `sync_status` — last sync time + error per source.

The full schema is documented in [`db-schema.md`](db-schema.md).

**Turn assembly is on-read, not on-write.** Each call to `GET /api/v1/sessions/:id/turns` runs `assembleTurns(sessionId)`:

1. `SELECT messages WHERE session_id ORDER BY ordinal` (one query).
2. Walk messages, opening a new turn on each user message, accumulating assistant + tool_result messages, marking turns truncated when a `[compact]` system event lands (D-10), and merging consecutive user messages as queued commands (D-05).
3. JOIN `tool_calls` + `tool_result_events` and attach to the appropriate turn.
4. JOIN child `sessions WHERE parent_session_id = ?` to add subagent links to the first turn.

This keeps the write path simple (parsers don't need to emit turn boundaries) and lets us evolve the assembler without rewriting indexed data.

---

## 6. Sync pipeline at a glance

The ingest service's `index.ts` boots in this order:

1. `loadConfig()` — parses `INGEST_*` env vars with strict validation.
2. `openDatabase()` + `initSchema()` — opens `data/ingest.db`, runs `schema.sql`, then `runMigrations()` (uses `PRAGMA user_version`, target version 6).
3. `serve(app)` on `INGEST_PORT` — HTTP is up immediately so `/health` can answer (with `ready: false`).
4. `initializeSourcesAndSync()` (background): discover sources → create `chokidar` watcher → run a **bounded warmup sync** (`INGEST_STARTUP_SYNC_LIMIT` newest files per source, default 50) → start the watcher → flip `ready: true` → if `INGEST_BACKGROUND_SYNC_ENABLED` is true, run a full consistency sync for each source through the scheduler.

This split — TCP open immediately, indexing in the background — was added in quick task 260509-nwg so the frontend doesn't block on a multi-thousand-file historical scan.

The watcher debounces file events (`INGEST_DEBOUNCE_MS`, default 500ms) and falls back to a periodic directory-consistency resync (`INGEST_RESYNC_INTERVAL_MS`, default 15 min). File changes enter path-scoped sync through the scheduler; periodic and manual refresh enter full-source consistency sync, which:

1. Discovers source dirs again (cheap; just `fs.readdir`).
2. Lists candidate `.jsonl` files (with mtime sort if a limit is set).
3. For each file: first compare `sessions.file_size` / `file_mtime` / parser cache version before parser work; changed files then use append cursors or full parse before transactional writes.
4. Emit SSE: `session_created` / `session_updated` per file, `sync_complete` per source.
5. Upsert `sync_status`.

The skip cache key is `parser-v11-qoder-token-calibrated-cost:<source>:<sha256>`, so bumping the parser cache version forces a global re-parse on next sync — used when parser output shape changes.

The watcher and sync internals are detailed in [`services/ingest.md`](services/ingest.md). The full reactive update path (file change → SSE → UI refetch) is in [`DATA-FLOW.md`](DATA-FLOW.md).

---

## 7. Frontend layout

Routes live under `app/(tool-shell)/[tool]/` (a route group, so `(tool-shell)` is not part of the URL). `[tool]` is one of `openclaw | claude-code | codex | opencode | all`. The root `app/page.tsx` redirects `/` to `/all/dashboard`.

The shell (`components/shell/shell-frame.tsx`) is a 3-row CSS grid: 48px header, 1fr main (with optional 360px right rail), 26px status bar. `SidebarNav` is a fixed 56px column; `SourceSwitcher` lives in the header.

Per-tool behaviour is driven by `AgentToolDefinition` records in `lib/agent-tools/{openclaw,claude-code,codex,opencode,all}/definition.ts`. The registry exposes:

- `capabilities` — feature flags (sessions, replay, activity, subagents, cost, …) that gate nav items and pages.
- `nav` — sidebar items, each with an optional `requiredCapability` flag.
- `ui` — brand label, session-table column definitions, optional dashboard slots, optional formatters.

`AgentToolProvider` (`lib/agent-tools/client-hooks.tsx`) wraps the tree with the resolved definition. Pages call `useAgentTool()` to get the current `toolId` and a `href(route)` builder that prepends `/<tool>`. Data hooks (`useSessionDetail`, `useSessionTurns`, …) hit the BFF, never ingest.

State management is split intentionally:

| Store | Purpose |
| --- | --- |
| `tool-store` | Currently-selected session, sidebar state |
| `replay-store` | Per-turn expand/collapse, search query, expanded blocks |
| `ui-store` | Right rail open, modal state |
| `ingest-health-store` | `'checking' \| 'connected' \| 'timeout'` from `/api/ingest/health` polling |
| `theme-store` | Light / dark / system (with the synchronous bootstrap script in `app/layout.tsx`) |
| `office-layout/` | OpenClaw 2D office floor plan persistence |

A deeper component-by-component tour is in [`services/frontend.md`](services/frontend.md).

---

## 8. Real-time invalidation

The frontend treats SSE events as **invalidation signals**, not as data updates (D-12 in the planning docs). When `session_updated` fires, the relevant React hook re-fetches the session detail; the SSE payload itself just tells us *what* to refetch.

```text
ingest writeSessionToDatabase()
  └─ commit transaction
  └─ sseManager.emit('session_updated', {sessionId, source})
  └─ sseManager.emitSessionEvent(sessionId, 'session_updated', {})

BFF /api/agent-tools/openclaw/events
  └─ proxies SSE body straight to browser EventSource

useSessionTurns(toolId, sessionId, ...)
  └─ subscribes to /api/agent-tools/<tool>/events?sessionId=<id>
  └─ on session_updated → refetch
```

This avoids two failure modes: (1) shipping potentially-large turn payloads through SSE, and (2) trying to incrementally merge turn assemblies on the client. The next fetch returns the canonical fresh state.

---

## 9. Configuration surface

All knobs are environment variables — the project deliberately has **no `.env.example`** to commit, but [`CONFIGURATION.md`](CONFIGURATION.md) lists every variable with its default and validation. The ones that almost always matter:

| Variable | Default | Why you care |
| --- | --- | --- |
| `OPENCLAW_DIR` | `~/.openclaw/agents` | OpenClaw source directory (multiple dirs configurable, see below) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code source directory |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex source directory |
| `AGENT_TRAIL_CONFIG` | `~/.agent-trail/config.json` | Path to config file (can define multiple directories; legacy `AGENTS_TRACING_CONFIG` remains supported) |
| `INGEST_PORT` | `8078` | Hono port |
| `INGEST_DB_PATH` | `./data/ingest.db` | SQLite file (path traversal blocked) |
| `INGEST_STARTUP_SYNC_LIMIT` | `50` | Newest files per source indexed before `ready: true` |
| `INGEST_BACKGROUND_SYNC_ENABLED` | `true` | Whether to do the full historical scan after warmup |

The **tool directory registry** (`ingest/config/tool-dirs.ts`) centralises per-source scan directories. Directory resolution priority: environment variable > config file (`~/.agent-trail/config.json`, with legacy `~/.agents-tracing/config.json` fallback) > built-in defaults. The config file can specify multiple directories (as an array); environment variables support a single directory only.

Frontend env vars (`NEXT_PUBLIC_*`) live in `.env.local` (gitignored).

---

## 10. Key decisions (canonical)

These are the load-bearing decisions encoded in the codebase. Numbered IDs match `.planning/` references.

| ID | Decision | Why |
| --- | --- | --- |
| **D-07** | BFF proxy is the only path frontend → ingest | Single source-scoping & error-sanitization point |
| **D-08** | Unified per-tool routing (one shell, one route table) | Avoid divergent dashboards for each source |
| **D-10** | Compact / system events stored as turn activities | Surface the boundary in replay without losing it |
| **D-11** | Turn assembler pairs tool calls + links subagents at read time | Keep parsers simple; evolve view layer freely |
| **D-12** | SSE = invalidation only, never data inline | Bound payload size; idempotent refresh |
| **D-14** | Source has independent `ingestStatus` + `gatewayStatus` | OpenClaw has Gateway; Claude/Codex don't |
| **D-21** | Enumerated source types only — no generic parser fallback | Source-specific log formats demand source-specific parsers |
| Skip cache | Parse skipped when `sha256(file) == sessions.file_hash` (versioned key) | Idempotent resync; bump version forces global re-parse |
| Read-only | The dashboard never executes tools or mutates session files | Safety + clear product scope (v1) |
| Local-first | No cloud, no telemetry, paths confined to configured roots | Sessions can contain code, paths, secrets |

For decision history and rationale, see [`.planning/PROJECT.md`](../.planning/PROJECT.md) and the per-phase `CONTEXT.md` files.

---

## 11. What this architecture deliberately doesn't do

- **No telemetry / OTLP collector.** This is a session viewer, not an observability platform.
- **No tool re-execution / replay-with-mutation.** Replay observes; it never re-runs.
- **No multi-user, no auth, no RBAC.** Single-user local tool.
- **No prompt playground, model-comparison, LLM-as-judge.** Out of v1 scope per `.planning/PROJECT.md`.
- **No public share links, no upload.** Sessions can leak credentials and code.
- **No agentsview-style universal-agent registry.** Supported sources are enumerated in the registry; see [COMPATIBILITY.md](COMPATIBILITY.md) for formats and limits (D-21).

When in doubt: **read-only, local-only, source-isolated**.
