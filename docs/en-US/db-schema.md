# Database Schema Reference

Current schema version is **24**. The table below is a historical summary; `ingest/db/schema.sql` and `runMigrations()` are authoritative. V24 widens source constraints for Command Code while retaining rows, indexes, triggers and foreign keys. Token usage JSON may include requestId and sourceCostUsd; neither requires a new column.
SQLite read model at `data/ingest.db`. Managed by the ingest service (`ingest/db/`). Uses WAL mode for concurrent read/write.

---

## Configuration

| Setting | Value | Source |
| --- | --- | --- |
| Path | `data/ingest.db` (default) or `INGEST_DB_PATH` | `ingest/config/index.ts` |
| Journal mode | WAL | `PRAGMA journal_mode = WAL` in `schema.sql` |
| Synchronous | NORMAL | `PRAGMA synchronous = NORMAL` in `schema.sql` |
| Migration tracking | `PRAGMA user_version` | `runMigrations()` in `db/index.ts` |
| Driver | `better-sqlite3` (synchronous API) | `db/index.ts` |

---

## Tables

### sessions

One row per session file. Contains metadata, file provenance, metrics, and relationship data.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | TEXT | **PK** | Session ID (e.g. UUID for Claude Code, `agent:{name}:{uuid}` for OpenClaw) |
| `source` | TEXT | NOT NULL, CHECK IN (`openclaw`, `claude-code`, `codex`, `opencode`, `qoder`, `commandcode`) | Which agent tool produced this session |
| `project` | TEXT | NOT NULL | Decoded project/cwd path |
| `name` | TEXT | nullable | Display name extracted from first user message |
| `started_at` | TEXT | nullable | ISO 8601 timestamp of first message |
| `ended_at` | TEXT | nullable | ISO 8601 timestamp of last message |
| `status` | TEXT | NOT NULL, CHECK IN (`active`, `idle`, `aborted`, `error`, `unknown`) | Session status determined by parser |
| `root_session_id` | TEXT | nullable, FK → sessions.id | Top-level session in a subagent tree |
| `parent_session_id` | TEXT | nullable, FK → sessions.id | Direct parent in subagent hierarchy |
| `relationship_type` | TEXT | nullable, CHECK IN (`root`, `subagent`, `fork`, `continuation`) | How this session relates to its parent |
| `message_count` | INTEGER | NOT NULL, DEFAULT 0 | Total messages in session |
| `user_message_count` | INTEGER | NOT NULL, DEFAULT 0 | User-role messages only |
| `total_output_tokens` | INTEGER | nullable | Sum of output tokens across turns |
| `has_tool_calls` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | Whether any tool calls exist |
| `file_path` | TEXT | NOT NULL | Absolute path to source JSONL file on disk |
| `file_size` | INTEGER | nullable | File size in bytes |
| `file_mtime` | TEXT | nullable | File modification time (ISO 8601) |
| `file_hash` | TEXT | nullable | Versioned parser cache key: `{version}:{source}:{sha256}` |
| `last_sync_at` | TEXT | nullable | Last successful sync timestamp (ISO 8601) |
| `cwd` | TEXT | nullable | Working directory from session metadata |
| `git_branch` | TEXT | nullable | Git branch from session metadata |
| `source_session_id` | TEXT | nullable | Original session ID from the source tool |
| `source_version` | TEXT | nullable | Source tool version string |
| `parser_malformed_lines` | INTEGER | NOT NULL, DEFAULT 0 | Count of unparseable JSONL lines |
| `is_truncated` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | Whether context window was compacted |
| `termination_status` | TEXT | nullable | How the session ended (e.g. `completed`, `cancelled`) |
| `source_cost_usd` | REAL | nullable | Source-reported cost in USD (opencode reports exact cost) |
| `cost_source` | TEXT | nullable | Cost source: `'source-reported'` for opencode, null for pricing registry estimates |
| `cost_pricing_status` | TEXT | nullable | Pricing status: `'priced'` (exact), `'reported_zero'` (cost=0 with tokens), null for estimates |

**Foreign keys:**
- `root_session_id` → `sessions.id` ON DELETE SET NULL
- `parent_session_id` → `sessions.id` ON DELETE SET NULL

---

### messages

Flattened, ordered message list. One row per message in a session.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | TEXT | **PK** | Message ID from parser, or fallback `{sessionId}:{ordinal}` |
| `session_id` | TEXT | NOT NULL, FK → sessions.id | Parent session |
| `ordinal` | INTEGER | NOT NULL | 0-based position within session |
| `role` | TEXT | NOT NULL, CHECK IN (`user`, `assistant`, `system`, `tool_result`) | Message role |
| `content` | TEXT | NOT NULL | Raw message content (may contain XML tags) |
| `timestamp` | TEXT | nullable | ISO 8601 |
| `model` | TEXT | nullable | Model name (e.g. `claude-sonnet-4-6`) |
| `has_tool_use` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | Whether assistant content blocks contain tool_use |
| `turn_id` | TEXT | nullable | Turn this message belongs to (populated by parser) |
| `turn_index` | INTEGER | nullable | Turn index (populated by parser) |
| `is_real_user_input` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | Distinguishes real user input from injected metadata |
| `token_usage_json` | TEXT | nullable | JSON-serialized `TokenUsage` object |
| `source_file` | TEXT | nullable | Source JSONL file path |
| `source_line` | INTEGER | nullable | Line number in source JSONL file |

**Unique constraint:** `UNIQUE(session_id, ordinal)`

**Foreign keys:**
- `session_id` → `sessions.id` ON DELETE CASCADE

---

### tool_calls

Individual tool invocations extracted from assistant message content blocks.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | Auto-generated row ID |
| `session_id` | TEXT | NOT NULL, FK → sessions.id | Parent session |
| `message_ordinal` | INTEGER | NOT NULL | Links to the assistant message containing this tool call |
| `tool_id` | TEXT | NOT NULL | Tool call ID from source (e.g. `toolu_01ABC...`) |
| `name` | TEXT | NOT NULL | Tool name (e.g. `Bash`, `Edit`, `Read`) |
| `category` | TEXT | nullable, CHECK IN (`Bash`, `Edit`, `Read`, `Grep`, `Task`, `Agent`, `Other`) | Tool category |
| `input_json` | TEXT | NOT NULL | JSON string of tool input arguments |
| `status` | TEXT | NOT NULL, CHECK IN (`pending`, `success`, `error`) | Tool execution status |
| `error` | TEXT | nullable | Error message if status is `error` |
| `duration_ms` | INTEGER | nullable | Execution duration in milliseconds |

**Foreign keys:**
- `session_id` → `sessions.id` ON DELETE CASCADE

---

### tool_result_events

Output events from tool executions. Multiple events can belong to one tool call (e.g. streaming output).

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | Auto-generated row ID |
| `tool_call_id` | INTEGER | NOT NULL, FK → tool_calls.id | Parent tool call |
| `timestamp` | TEXT | nullable | ISO 8601 |
| `content` | TEXT | NOT NULL | Event content (stdout, file content, etc.) |
| `is_partial` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | Whether this is a partial/streaming event |

**Foreign keys:**
- `tool_call_id` → `tool_calls.id` ON DELETE CASCADE

---

### turns

Pre-computed or assembler-built turn rows. A turn groups one user message with its subsequent assistant/tool_result messages.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | TEXT | **PK** | Turn ID (typically `{sessionId}-turn-{index}`) |
| `session_id` | TEXT | NOT NULL, FK → sessions.id | Parent session |
| `turn_index` | INTEGER | NOT NULL | 0-based turn position |
| `user_message_id` | TEXT | nullable, FK → messages.id | The user message that opens this turn |
| `started_at` | TEXT | nullable | ISO 8601 |
| `ended_at` | TEXT | nullable | ISO 8601 |
| `duration_ms` | INTEGER | nullable | Turn duration |
| `token_usage_json` | TEXT | nullable | JSON-serialized `TokenUsage` for this turn |

**Unique constraint:** `UNIQUE(session_id, turn_index)`

**Foreign keys:**
- `session_id` → `sessions.id` ON DELETE CASCADE
- `user_message_id` → `messages.id` ON DELETE SET NULL

---

### sync_status

Per-source sync health tracking. One row per source type.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `source_type` | TEXT | **PK** | Source type (`openclaw`, `claude-code`, `codex`, `opencode`, `qoder`, `commandcode`) |
| `last_full_sync_at` | TEXT | nullable | Timestamp of last full resync |
| `last_watch_sync_at` | TEXT | nullable | Timestamp of last file-watcher-triggered sync |
| `files_watched` | INTEGER | NOT NULL, DEFAULT 0 | Number of session files processed |
| `last_error` | TEXT | nullable | Last error message (null if healthy) |

---

## Indexes

### sessions

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_sessions_source_project` | `(source, project)` | Filter sessions by source and project |
| `idx_sessions_started_at` | `(started_at DESC)` | Sort by recency |
| `idx_sessions_root_session_id` | `(root_session_id)` | Subagent tree traversal |
| `idx_sessions_parent_session_id` | `(parent_session_id)` | Direct parent lookup |

### messages

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_messages_session_id` | `(session_id)` | Fetch all messages for a session |
| `idx_messages_session_ordinal` | `(session_id, ordinal)` | Ordered message retrieval with unique constraint |
| `idx_messages_session_turn_index` | `(session_id, turn_index)` | Turn-ordered message lookup (migration-added) |

### tool_calls

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_tool_calls_session_id` | `(session_id)` | All tool calls for a session |
| `idx_tool_calls_message_ordinal` | `(message_ordinal)` | Tool calls by message |

### tool_result_events

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_tool_result_events_tool_call_id` | `(tool_call_id)` | Events for a specific tool call |

### turns

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_turns_session_id` | `(session_id)` | All turns for a session |
| `idx_turns_session_index` | `(session_id, turn_index)` | Ordered turn retrieval |

---

## Entity Relationships

```text
sessions (1) ──< (N) messages
  │                    │
  │                    └── ordinal → links to tool_calls.message_ordinal
  │
  ├─< (N) tool_calls ──< (N) tool_result_events
  │
  ├─< (N) turns
  │
  └── self-referential:
       root_session_id   → sessions.id (subagent tree root)
       parent_session_id → sessions.id (direct parent)
```

Cascading deletes flow from sessions → messages, tool_calls, turns. Tool_calls → tool_result_events cascade as well.

---

## Skip Cache

The `file_hash` column implements the skip cache to avoid re-parsing unchanged files:

1. Compute SHA-256 of the source JSONL file
2. Build versioned cache key: `{PARSER_CACHE_VERSION}:{source}:{sha256}`
3. Compare against `sessions.file_hash`
4. If match: skip full parse, only patch `name`/`project` if empty
5. If mismatch (or NULL): full upsert — delete derived rows, re-insert

`PARSER_CACHE_VERSION` is `parser-v11-qoder-token-calibrated-cost`. When parser logic changes, incrementing this version invalidates all cached sessions.

**Force reparse:** `writeSessionToDatabase()` accepts `{ force: true }` to bypass the skip cache entirely.

---

## Migrations

Managed via `PRAGMA user_version` in `runMigrations()` (`ingest/db/index.ts`). Current target: **v6**.

| Migration | Description |
| --- | --- |
| v1 | Add `file_hash`, `last_sync_at` columns to sessions |
| v2 | Add `name` column to sessions |
| v3 | Invalidate skip cache for repaired name extraction |
| v4 | Invalidate stale project/name rows after parser cwd fixes |
| v5 | Add `turn_id`, `turn_index`, `is_real_user_input` columns to messages; add `idx_messages_session_turn_index` |
| v6 | Invalidate Claude/Codex parser cache for turn/relationship repairs |

Migrations use `ALTER TABLE ADD COLUMN` wrapped in try/catch to handle already-applied columns gracefully. Schema is always created fresh from `schema.sql` on first run; migrations handle upgrades for existing databases.

---

## Lifecycle

1. **Boot:** `openDatabase()` creates directory, opens SQLite, enables WAL
2. **Init:** `initSchema()` executes `schema.sql` → `runMigrations()` → verifies all core tables exist
3. **Runtime:** `writeSessionToDatabase()` performs transactional writes; `assembleTurns()` performs read queries
4. **Shutdown:** `closeDatabase()` cleanly closes the connection

The database module exports a singleton `db` handle. All other modules import `getDatabase()` to access it.
