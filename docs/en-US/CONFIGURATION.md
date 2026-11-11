# Configuration

agent-trail is configured through environment variables and an optional config file. Source directory resolution follows a three-layer priority: **env var > config.json > built-in defaults**. Both services parse `process.env` at startup. This document lists every variable the code actually reads, where it's read, the default, and the validation that runs against it.

> **Convention.** Variables prefixed `NEXT_PUBLIC_` are exposed to browser bundles by Next.js — never put secrets there. Variables prefixed `INGEST_` are read only by the ingest service. Variables without a prefix (e.g. `WORKSPACE_PATH`) are read by both services.

---

## 1. Where to put values

| File | Loaded by | Committed? |
| --- | --- | --- |
| `.env.local` | Next.js automatically; the ingest service when launched via `pnpm dev:ingest` (which inherits the parent shell env) | No (gitignored — see `.gitignore`) |
| `~/.agent-trail/config.json` | `ingest/config/tool-dirs.ts → loadConfigFile` — multi-path source directory configuration | No (user home directory) |
| Shell exports / launcher script | Both services when started directly | n/a |
| `.ovao-config.json` | `lib/gateway-config.ts` (Gateway URL/Token persistence) | No (gitignored) — managed at runtime, do not hand-edit |

There is **no** `.env.example` checked into the repo. The minimum local setup is documented in [`GETTING-STARTED.md`](GETTING-STARTED.md).

---

## 2. Source discovery (Tool Directory Registry)

Source directories are managed centrally via `TOOL_DIR_REGISTRY` and `resolveToolDirs()` in `ingest/config/tool-dirs.ts`. Resolution follows a three-layer priority: **env var > config.json > built-in defaults**.

### `AGENT_TRAIL_CONFIG`

- **Default:** `~/.agent-trail/config.json`.
- **Read at:** `ingest/config/tool-dirs.ts → loadConfigFile`.
- **Purpose:** Override the config file path. If unset, Agent Trail prefers `~/.agent-trail/config.json`; if that file does not exist, it falls back to the legacy `~/.agents-tracing/config.json`. If neither exists, it is silently ignored (returns `null`).
- **Compatibility:** The legacy `AGENTS_TRACING_CONFIG` variable is still supported, but new docs use `AGENT_TRAIL_CONFIG`.

### `OPENCLAW_DIR`

- **Default:** `~/.openclaw/agents`.
- **Config file key:** `openclaw_dirs` (array, supports multiple paths).
- **Read at:** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`.
- **Resolves to:** `<dir>/<agent-name>/agent/openclaw-agent.sqlite` plus legacy/exported archive JSONL under `sessions/`.
- **Path containment:** Discovered paths are validated by `isWithinRoot` against the resolved root. Anything outside is dropped with `[sources] Rejected path outside root: ...` printed to the ingest log.

### `CLAUDE_PROJECTS_DIR`

- **Default:** `~/.claude/projects`.
- **Config file key:** `claude_project_dirs` (array, supports multiple paths).
- **Read at:** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`.
- **Resolves to:** any directory under the root containing `.jsonl` files (recursive discovery).
- **Project extraction:** Claude encodes the original `cwd` by replacing `/` with `-` in the directory name (e.g. `-Users-ebbi-work-foo`). The sync layer decodes this back into the `project` column.

### `CODEX_SESSIONS_DIR`

- **Default:** `~/.codex/sessions`.
- **Config file key:** `codex_sessions_dirs` (array, supports multiple paths).
- **Read at:** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`.
- **Resolves to:** any directory under the root containing `.jsonl` files (recursive). Codex parent-child relationships are reconstructed from `event_msg.collab_agent_spawn_end` events during sync.

### `OPENCODE_DB_PATH`

- **Default:** `~/.local/share/opencode/opencode.db`.
- **Config file key:** `opencode_db_paths` (array).
- **Read at:** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`.
- **Resolves to:** OpenCode's SQLite database file (not a JSONL file directory). The parser opens this DB read-only, extracting data from `session`, `message`, `part`, and `project` tables.
- **Note:** OpenCode stores session data in SQLite, not JSONL files. This path points to a single `.db` file.

### `COMMANDCODE_PROJECTS_DIR`

Defaults to `~/.commandcode/projects`; config key `commandcode_project_dirs` accepts an array. Only v3 historical transcripts and their title sidecars are imported; hook telemetry under `~/.commandcode/sessions` is not a transcript source. See [COMPATIBILITY.md](COMPATIBILITY.md).

### `QODER_DB_PATH`

- **Default:** `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db` (macOS).
- **Config file key:** `qoder_db_paths` (array, supports multiple paths).
- **Read at:** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`, `ingest/sync/sources.ts → discoverQoderSources`.
- **Resolves to:** Qoder's local SQLite database file. The parser opens this DB read-only and extracts `chat_session`, `chat_record`, and `chat_message`.
- **Privacy boundary:** The ingest service opens Qoder DBs with `readonly: true` and `fileMustExist: true`, never writes to the DB, and does not read token/auth stores.
- **Cost estimate:** Local Qoder data does not expose readable per-session credit consumption. The parser reads assistant `token_info` from the root session plus recursive subagents, estimates credits with `QODER_BASE_CREDITS_PER_M_TOKENS` and the model multiplier, then converts credits to USD with `QODER_USD_PER_CREDIT`. The default calibration is base 1.0 model `45.986482` credits / 1M gross tokens, current Ultimate promo `0.8x`, or normal Ultimate via `QODER_ULTIMATE_MULTIPLIER=1.6`.

### `WORKSPACE_PATH` (deprecated)

- **Default:** `~/.openclaw` (after stripping a trailing `/workspace` if present).
- **Note:** This variable has been superseded by `OPENCLAW_DIR`. Kept for backwards compatibility. If `OPENCLAW_DIR` is also set, `OPENCLAW_DIR` takes precedence.

### Config file format

`~/.agent-trail/config.json` supports multi-directory scanning:

```json
{
  "openclaw_dirs": ["/Users/<you>/.openclaw/agents"],
  "claude_project_dirs": ["/Users/<you>/.claude/projects"],
  "codex_sessions_dirs": ["/Users/<you>/.codex/sessions"],
  "opencode_db_path": "/Users/<you>/.local/share/opencode/opencode.db",
  "qoder_db_paths": ["/Users/<you>/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db"]
}
```

Each key accepts an array of paths. Relative paths are resolved from the user's home directory (`~`). When an env var is set, the corresponding config file key is ignored (env var takes priority).

---

## 3. Ingest service (`ingest/config/index.ts`)

`loadConfig()` runs at startup and **throws on invalid values** (the service exits). Defaults below match `IngestConfig`. See [`services/ingest.md`](services/ingest.md) for what each knob actually changes at runtime.

| Variable | Default | Validation | Effect |
| --- | --- | --- | --- |
| `INGEST_PORT` | `8078` | Integer in `[1024, 65535]` | TCP port for the Hono server. |
| `INGEST_DB_PATH` | `./data/ingest.db` | Non-empty; cannot contain `..` (path traversal) | Resolved to absolute path. Parent directory is created on open. |
| `AGENT_TRAIL_LOG_LEVEL` / `INGEST_LOG_LEVEL` | `info` in development, `warn` in production/package runs | One of `silent \| error \| warn \| info \| debug` | Controls runtime logs. The npm/Docker launcher buffers child logs by default and prints them on failure; set `debug` to stream verbose logs live. The legacy `AGENTS_TRACING_LOG_LEVEL` variable remains supported as a fallback. |
| `QODER_BASE_CREDITS_PER_M_TOKENS` | `45.986482` | Parses as a non-negative number | Base 1.0 model credits per 1M gross tokens for Qoder token-calibrated estimates. |
| `QODER_ULTIMATE_MULTIPLIER` | `0.8` | Parses as a non-negative number | Ultimate model multiplier. Current promo is `0.8`; set `1.6` to estimate normal Ultimate pricing. |
| `QODER_USD_PER_CREDIT` | `0.01` | Parses as a non-negative number | USD value used when converting Qoder credit estimates to session cost. |
| `INGEST_RESYNC_INTERVAL_MS` | `900000` (15 min) | Integer ≥ 5000 | Periodic directory-consistency resync interval for the file watcher. |
| `INGEST_DEBOUNCE_MS` | `500` | Integer ≥ 100 | Debounce window between filesystem events and a sync trigger. |
| `INGEST_STARTUP_SYNC_LIMIT` | `50` | Integer ≥ 0 | Newest files per source parsed during the warmup pass before `/health` reports `ready: true`. `0` skips warmup entirely. |
| `INGEST_BACKGROUND_SYNC_ENABLED` | `true` | Truthy: `true \| 1 \| yes` (case-insensitive) | When true, after warmup the service runs a full historical sync per source. |
| `INGEST_RATE_LIMIT_RPM` | `100` | Falls back to `100` if unparseable | Requests per minute per IP. |
| `INGEST_RATE_LIMIT_ENABLED` | `true` | Truthy: `true \| 1 \| yes` | Toggles `rateLimiter` middleware. `/health` and `/version` are always exempt. |
| `INGEST_DEBUG` | `false` | Truthy: `true \| 1 \| yes` | When true, the global error handler returns the actual `err.message` and stack to clients. **Never enable in shared environments** — turn off before sharing logs. |

`getConfig()` caches the result; `loadConfig()` reloads (used by tests).

### Invalid-value behaviour

Bad values produce a fatal startup error, e.g.:

```text
Error: Invalid INGEST_PORT: 99 must be between 1024 and 65535
Error: Invalid INGEST_RESYNC_INTERVAL_MS: "1000" must be at least 5000ms
Error: INGEST_DB_PATH cannot contain ".." (path traversal)
```

Set them in `.env.local` or via the launching shell; if the values are wrong, the service exits before binding the port (`pnpm dev` will then show only the `[NEXT]` prefix continuing).

---

## 4. Frontend (`app/` and `lib/`)

| Variable | Default | Read at | Purpose |
| --- | --- | --- | --- |
| `INGEST_URL` | `http://localhost:8078` | `lib/agent-tools/server-adapter.ts` (`fetchIngest`); `app/api/agent-tools/[tool]/events/route.ts` | Base URL the BFF uses to talk to the ingest service. Server-side only. |
| `NEXT_PUBLIC_API_BASE` | _(none — must be set if used)_ | `.env.local` only; **no current import** in source. Documented in `CLAUDE.md` as the expected HTTP API endpoint for older OpenClaw consumers. | Currently unused by code paths in the repo; kept for backwards-compat with the OVAO era. |
| `NEXT_PUBLIC_GATEWAY_WS` | _(none — must be set if used)_ | `.env.local` only; **no current import** in source. Documented in `CLAUDE.md` as the OpenClaw Gateway WebSocket URL. | Currently unused by repo source. The GatewayBootstrap / WS client is not wired up in the active multi-source frontend; it remains in `.planning/` history. <!-- VERIFY: confirm whether NEXT_PUBLIC_GATEWAY_WS is required by any deployment surface beyond docs --> |
| `PORT` | npm/Docker `3030`; source scripts explicitly use `3029` | CLI / Next.js | Use `pnpm exec next dev --webpack --port 3031` for another source dev port. |

The empty `.env.local` shipped during local setup typically contains:

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8000
NEXT_PUBLIC_GATEWAY_WS=ws://localhost:18789
OPENCLAW_DIR=/Users/<you>/.openclaw/agents
CLAUDE_PROJECTS_DIR=/Users/<you>/.claude/projects
CODEX_SESSIONS_DIR=/Users/<you>/.codex/sessions
```

`OPENCLAW_DIR`, `CLAUDE_PROJECTS_DIR`, `CODEX_SESSIONS_DIR`, and `OPENCODE_DB_PATH` control source discovery. You can also configure them via `~/.agent-trail/config.json` (which supports multiple directories); legacy `~/.agents-tracing/config.json` remains supported as a fallback. Keep the `NEXT_PUBLIC_*` variables for parity with older OpenClaw tooling unless you're sure nothing in your local stack reads them.

---

## 5. Build-time configuration

| File | What it controls |
| --- | --- |
| `next.config.ts` | Empty `NextConfig` — Next 16 defaults. No Turbopack flag is set in code; `pnpm dev:next` runs with `--webpack` because Turbopack triggered a compile storm in this codebase (see `../../ERRORS_LEARNED.md` and the 20260506-001 quick fix). |
| `postcss.config.mjs` | Loads `@tailwindcss/postcss` — required for Tailwind v4 with Next. |
| `app/globals.css` | Theme tokens via `@theme inline { ... }`. **There is no `tailwind.config.js`** — change colors / fonts / breakpoints here. |
| `tsconfig.json` | `target: ES2017`, `moduleResolution: bundler`, strict; includes `ingest/**/*` so types like `@/types/trace` resolve from both projects. |
| `ingest/tsconfig.json` | Project reference for the ingest service; `tsc -p ingest/tsconfig.json` builds to `ingest/dist/`. |
| `eslint.config.mjs` | Flat config based on `eslint-config-next`; ignores `.next/`, `out/`, `build/`, `next-env.d.ts`. |
| `vitest.config.ts` | Includes `tests/**/*.test.{ts,tsx}`, `lib/**/*.test.{ts,tsx}`, `ingest/**/*.test.ts`. Environment is `node` by default; component tests pull in jsdom explicitly. |
| `components.json` | shadcn config: `style: "radix-nova"`, `baseColor: "neutral"`, `iconLibrary: "lucide"`, components alias `@/components/ui`. |
| `.gitignore` | `.env*`, `data/`, `ingest/dist/`, `.ovao-config.json`, `.local/real-session-corpus.json`, `.next/`, etc. |

---

## 6. Runtime / operational settings (not in code)

These don't appear in source but show up in operational practice:

- **`pnpm dev` colour prefixes.** `concurrently -k --names "INGEST,NEXT" --prefix-colors "green,blue"` wraps both services. Override colors with `--prefix-colors` if your terminal can't render them.
- **Process supervision.** Outside `pnpm dev`, the production startup is `pnpm start` (Next) and `pnpm start:ingest` (Hono). Both are plain `node` processes — wrap in `pm2`, `systemd`, or your launcher of choice; neither is daemonized internally.
- **DB durability.** SQLite is opened with WAL (`PRAGMA journal_mode = WAL`, `synchronous = NORMAL`). The `data/ingest.db-wal` and `data/ingest.db-shm` files are normal — don't delete them while the service is running. Stop ingest first.
- **Restart vs reset.** Deleting `data/ingest.db` is the safe full-reset path: the service recreates the schema and migrates from scratch on next start. There is no migration rollback — going backwards means nuking the DB.

---

## 7. Configuration troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Ingest exits immediately on `pnpm dev:ingest` | Bad `INGEST_*` value (e.g. unparseable port) | Read the printed `Error:` line; values must satisfy the validation table above |
| `/api/v1/sources` shows `error: "ENOENT: ..."` for a source | Source root does not exist | Set the matching `OPENCLAW_DIR` / `CLAUDE_PROJECTS_DIR` / `CODEX_SESSIONS_DIR` / `OPENCODE_DB_PATH` env var, or configure paths in `~/.agent-trail/config.json`, or create the directory |
| OpenClaw source appears with `sessionCount: 0, error: "No agent sessions found"` | `~/.openclaw/agents/<agent>/sessions/` is empty | Run an OpenClaw session to create some, or point `OPENCLAW_DIR` at a directory that has them |
| `[sources] Rejected path outside root: ...` warnings | Symlink leaving the configured root, or a weird absolute path discovered | Fix the symlink; `isWithinRoot` is intentional and not configurable |
| BFF returns 502 `Ingest service unreachable` | Ingest crashed or wrong `INGEST_URL` | Check `pnpm dev` logs; `curl http://localhost:8078/health`; reset `INGEST_URL` |
| BFF returns 400 `Invalid source tool ID` | URL `[tool]` segment is wrong | Use `openclaw`, `claude-code`, `codex`, `opencode`, or `qoder` (note the hyphens). `all` works only at the shell layer, not the BFF. |
| Health overlay stays in "checking" forever | Ingest is up but `INGEST_STARTUP_SYNC_LIMIT` is huge and warmup hasn't finished | Lower the limit or set it to `0` to skip warmup; full sync still runs in the background |

For "I made a parser change and the DB is showing stale data," see the skip-cache section of [`services/ingest.md`](services/ingest.md): bump `PARSER_CACHE_VERSION` or call `POST /api/v1/sources/:type/sync` with `{"force": true}`.
