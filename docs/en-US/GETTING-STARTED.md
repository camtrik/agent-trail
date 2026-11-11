# Getting started

This guide takes a fresh checkout to a working dashboard with at least one source indexed. Plan for ~5 minutes if you already have OpenClaw, Claude Code, or Codex sessions on disk; ~15 if you need to install Node and pnpm first.

> Architecture context: [`ARCHITECTURE.md`](ARCHITECTURE.md). For every config knob, [`CONFIGURATION.md`](CONFIGURATION.md). For day-to-day workflows after setup, [`DEVELOPMENT.md`](DEVELOPMENT.md).

---

## 1. Prerequisites

- **Node.js 24 recommended.** Development, CI and Docker are verified with Node 24; native SQLite may need a compiler when a matching prebuild is unavailable.
- **pnpm 11.1.3.** Use pnpm — `pnpm-lock.yaml` is the source of truth. `corepack enable && corepack prepare pnpm@11.1.3 --activate` works on a fresh machine.
- **A platform with native `better-sqlite3`.** macOS (arm64/x64), Linux, and Windows all have prebuilds. If `pnpm install` rebuilds it from source, you need a working C/C++ toolchain.
- **At least one source directory** (otherwise the dashboard will load with empty source lists):
  - OpenClaw: a `~/.openclaw/agents/<agent-name>/sessions/*.jsonl` tree (or your own location pointed at by `OPENCLAW_DIR`).
  - Claude Code: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (Claude Code creates these automatically when you run sessions).
  - Codex: `~/.codex/sessions/*.jsonl`.

You do not need every supported source; see [COMPATIBILITY.md](COMPATIBILITY.md) for all formats and limits. The dashboard will show only the sources it can find.

---

## 2. Install

```bash
git clone <your-repo-url> agent-trail
cd agent-trail
pnpm install
```

`pnpm install` will compile / fetch the prebuild for `better-sqlite3` — this is the slowest step.

---

## 3. Configure

Tool directories are resolved through a three-layer config (highest priority first): **environment variables** > **config file** > **built-in defaults**.

### Option A: Environment variables (parent shell)

Export settings in the shell that launches both services. Only Next.js loads `.env.local`; the separate ingest process does not:

```bash
# Shell — only set the lines you actually need

# OpenClaw — only needed if your OpenClaw root is not ~/.openclaw
# export OPENCLAW_DIR=/path/to/openclaw/agents

# Claude Code — only needed if Claude saves sessions somewhere other than ~/.claude/projects
# export CLAUDE_PROJECTS_DIR=/path/to/claude/projects

# Codex — only needed if Codex saves sessions somewhere other than ~/.codex/sessions
# export CODEX_SESSIONS_DIR=/path/to/codex/sessions

# Optional ingest tuning (defaults are usually fine)
# export INGEST_PORT=8078
# export INGEST_DB_PATH=./data/ingest.db
# export INGEST_STARTUP_SYNC_LIMIT=50
# export INGEST_BACKGROUND_SYNC_ENABLED=true
```

### Option B: Config file (`~/.agent-trail/config.json`)

If you prefer not to create a `.env.local` per project, use the global config file:

```json
{
  "openclaw_dirs": ["/path/to/openclaw/agents"],
  "claude_project_dirs": ["/path/to/claude/projects"],
  "codex_sessions_dirs": ["/path/to/codex/sessions"]
}
```

The config file path can be overridden via the `AGENT_TRAIL_CONFIG` environment variable. The legacy `AGENTS_TRACING_CONFIG` variable remains supported as a fallback. Config values support multiple directories (as arrays) and relative paths (resolved against `$HOME`).

The full variable list with defaults and validation rules lives in [`CONFIGURATION.md`](CONFIGURATION.md).

`.env.local` is git-ignored; do not commit it.

---

## 4. Start both services

```bash
pnpm dev
```

`concurrently` brings up both:

- `[INGEST]` (green) — Hono on port 8078
- `[NEXT]`   (blue)  — Next.js on port 3029 (started with `--webpack`, not Turbopack)

You should see something like:

```text
[INGEST] Configuration loaded: { port: 8078, dbPath: '/.../data/ingest.db', ... }
[INGEST] Opening database: /.../data/ingest.db
[INGEST] Initializing database schema...
[INGEST] WAL mode enabled
[INGEST] Verified 6 tables created: sessions, messages, tool_calls, tool_result_events, turns, sync_status
[INGEST] Ingest service listening on port 8078
[INGEST] Discovering source directories...
[INGEST] Starting file watcher...
[INGEST] Running startup warmup sync: latest 50 files per source...
[INGEST]   Warmup sync openclaw: +12 new, ~3 updated
[INGEST]   Warmup sync claude-code: +50 new, ~0 updated
[INGEST]   Warmup sync codex: +0 new, ~0 updated
[NEXT]    ▲ Next.js 16.4.6 (webpack)
[NEXT]    - Local: http://localhost:3029
[NEXT]    ✓ Ready in 2.4s
```

`Ctrl+C` once stops both.

If only `[NEXT]` keeps printing while `[INGEST]` exited, you almost certainly have a bad `INGEST_*` value — see the troubleshooting table in [`CONFIGURATION.md`](CONFIGURATION.md#7-configuration-troubleshooting).

---

## 5. Verify

In another terminal:

```bash
# 1. Frontend reachable (will redirect /, follow with -L)
curl -I http://localhost:3029

# 2. Ingest health — once warmup finishes, "ready" flips to true
curl http://localhost:8078/health
# → {"status":"ok","ready":true,"version":"0.1.1","uptime":12.3,"database":"connected","sync":{...}}

# 3. Sources discovered
curl http://localhost:8078/api/v1/sources
# → {"sources":[{"type":"openclaw","path":"...","sessionCount":42,"healthStatus":"configured", ...}, ...]}

# 4. Sessions for a single source via the BFF (no source= needed — the URL segment supplies it)
curl 'http://localhost:3029/api/agent-tools/claude-code/sessions?limit=3'
```

Open `http://localhost:3029`. You'll be redirected to `/all/dashboard` (the aggregate view). The bottom status bar should read `INGEST · ONLINE`.

The header has a source switcher — click `OPENCLAW`, `CLAUDE:CODE`, or `CODEX` to scope the shell to a single tool. Each tool has its own dashboard, sessions list, and (for OpenClaw) activity views. Clicking a session opens the turn-by-turn replay UI under `/[tool]/sessions/[sessionId]`.

---

## 6. What you actually have running

```text
data/ingest.db          ← SQLite read model (gitignored). Safe to delete and re-sync.
data/ingest.db-wal      ← Write-ahead log. Don't delete while ingest is running.
data/ingest.db-shm      ← Shared memory file. Same caveat.
.next/                  ← Next dev artifacts.
ingest/dist/            ← Production build of ingest (only after pnpm build:ingest).
```

The two services are independent processes connected by HTTP + SSE on `localhost:8078` ↔ `localhost:3029`. The frontend never reaches into the database directly. Every UI fetch passes through the BFF (`app/api/agent-tools/[tool]/...`).

For the full request path from URL to React, see [`DATA-FLOW.md`](DATA-FLOW.md). For the per-service breakdown, see [`services/ingest.md`](services/ingest.md) and [`services/frontend.md`](services/frontend.md).

---

## 7. First-run troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Port 3029 already in use` | Another dev server | `lsof -ti:3029 \| xargs kill` or run `pnpm exec next dev --webpack --port 3031` |
| `Port 8078 already in use` | Stale ingest from a prior session | `lsof -ti:8078 \| xargs kill`, or set `INGEST_PORT=8079` |
| "INGEST OFFLINE" in the status bar | Ingest crashed or hasn't started | Check the `[INGEST]` lines for stack traces; restart with `pnpm dev:ingest` |
| Empty session list for OpenClaw | `OPENCLAW_DIR` wrong, or `~/.openclaw/agents/*/sessions/` is empty | Verify with `curl http://localhost:8078/api/v1/sources/openclaw`; the `path` field in the response is what the discoverer is looking at. Paths are configurable via env vars or `~/.agent-trail/config.json` |
| Empty session list for Claude Code | Claude saves elsewhere (or hasn't run yet) | `ls ~/.claude/projects/` should show project directories with `.jsonl` files; if not, Claude Code hasn't recorded any sessions |
| Type errors after pulling | Frontend and ingest share `types/trace.ts` — old build cache | `pnpm typecheck` to confirm; remove `tsconfig.tsbuildinfo` if it lies |
| Compile storm / 100% CPU on `pnpm dev:next` | Don't switch to Turbopack — keep the `--webpack` flag | See `../../ERRORS_LEARNED.md` for context |
| Replay shows "NO TURNS" for a session you know has content | File hash matches but the parser cache version is stale | Bump `PARSER_CACHE_VERSION` in `ingest/sync/index.ts`, restart, and re-sync; or run `curl -X POST http://localhost:3029/api/agent-tools/<tool>/sync -H 'content-type: application/json' -d '{"force":true}'` |

---

## 8. What's next

- Day-to-day workflow (hot reload, debugging, conventions): [`DEVELOPMENT.md`](DEVELOPMENT.md)
- Running the test suite: [`TESTING.md`](TESTING.md)
- API reference (every endpoint): [`API.md`](API.md)
- Database schema: [`db-schema.md`](db-schema.md)
