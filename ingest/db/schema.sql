-- Agent Tracing Dashboard - Ingest Service SQLite Schema
-- Adapted from trace contract (types/trace.ts)
-- Supports OpenClaw, Claude Code, Codex, OpenCode, and Qoder sources

-- ============================================================================
-- Sessions Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Source identification
  source TEXT NOT NULL CHECK(source IN ('openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder')),
  project TEXT NOT NULL,
  name TEXT,
  agent_name TEXT,

  -- Timestamps
  started_at TEXT,
  ended_at TEXT,

  -- Status
  status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'aborted', 'error', 'unknown')),

  -- Relationships
  root_session_id TEXT,
  parent_session_id TEXT,
  relationship_type TEXT CHECK(relationship_type IN ('root', 'subagent', 'fork', 'continuation')),

  -- Metrics
  message_count INTEGER NOT NULL DEFAULT 0,
  user_message_count INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,

  -- Tool/activity indicators
  has_tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(has_tool_calls IN (0, 1)),

  -- File provenance
  file_path TEXT NOT NULL,
  file_size INTEGER,
  file_mtime TEXT,
  file_hash TEXT,
  last_sync_at TEXT,

  -- Context metadata
  cwd TEXT,
  git_branch TEXT,

  -- Source identifiers
  source_session_id TEXT,
  source_version TEXT,

  -- Parser metadata
  parser_malformed_lines INTEGER NOT NULL DEFAULT 0,
  is_truncated INTEGER NOT NULL DEFAULT 0 CHECK(is_truncated IN (0, 1)),
  termination_status TEXT,

  -- Source-reported cost fields (Phase 17 — opencode integration)
  source_cost_usd REAL,
  cost_source TEXT,
  cost_pricing_status TEXT,

  -- Foreign keys
  FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

-- ============================================================================
-- Messages Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Session relationship
  session_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,

  -- Message content
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool_result')),
  content TEXT NOT NULL,
  timestamp TEXT,
  model TEXT,

  -- Tool use indicator
  has_tool_use INTEGER NOT NULL DEFAULT 0 CHECK(has_tool_use IN (0, 1)),

  -- Turn provenance
  turn_id TEXT,
  turn_index INTEGER,
  is_real_user_input INTEGER NOT NULL DEFAULT 0 CHECK(is_real_user_input IN (0, 1)),

  -- Token usage (JSON string of TokenUsage interface)
  token_usage_json TEXT,

  -- Source provenance
  source_file TEXT,
  source_line INTEGER,

  -- Foreign key
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,

  -- Unique constraint
  UNIQUE(session_id, ordinal)
);

-- ============================================================================
-- Tool Calls Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS tool_calls (
  -- Primary key
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Session relationship
  session_id TEXT NOT NULL,

  -- Message relationship (link to messages.ordinal)
  message_ordinal INTEGER NOT NULL,

  -- Tool identification
  tool_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT CHECK(category IN ('Bash', 'Edit', 'Read', 'Grep', 'Task', 'Agent', 'Other')),

  -- Tool input/output
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'success', 'error')),
  error TEXT,
  duration_ms INTEGER,

  -- Foreign key
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- ============================================================================
-- Tool Result Events Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS tool_result_events (
  -- Primary key
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Tool call relationship
  tool_call_id INTEGER NOT NULL,

  -- Event data
  timestamp TEXT,
  content TEXT NOT NULL,
  is_partial INTEGER NOT NULL DEFAULT 0 CHECK(is_partial IN (0, 1)),

  -- Foreign key
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls(id) ON DELETE CASCADE
);

-- ============================================================================
-- Subagent Links Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS subagent_links (
  -- Primary key
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Parent session relationship
  session_id TEXT NOT NULL,

  -- Child session reference. The child row may not have been indexed yet, so this
  -- intentionally does not use a foreign key to sessions(id).
  subagent_session_id TEXT NOT NULL,
  subagent_source TEXT NOT NULL CHECK(subagent_source IN ('openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder')),
  relationship TEXT NOT NULL CHECK(relationship IN ('spawned', 'attached')),

  -- Ordinal of the message/tool call that spawned or attached the child session.
  message_ordinal INTEGER,

  -- Foreign key
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- ============================================================================
-- Turns Table (NEW - turn-first read model)
-- ============================================================================

CREATE TABLE IF NOT EXISTS turns (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Session relationship
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,

  -- User message relationship
  user_message_id TEXT,

  -- Timestamps
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,

  -- Token usage (JSON string of TokenUsage interface)
  token_usage_json TEXT,

  -- Foreign key
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_message_id) REFERENCES messages(id) ON DELETE SET NULL,

  -- Unique constraint
  UNIQUE(session_id, turn_index)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Sessions indexes
CREATE INDEX IF NOT EXISTS idx_sessions_source_project ON sessions(source, project);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source_started_at ON sessions(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_root_session_id ON sessions(root_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);

-- Messages indexes
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_ordinal ON messages(session_id, ordinal);

-- Tool calls indexes
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message_ordinal ON tool_calls(message_ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_session_tool_id_unique
  ON tool_calls(session_id, tool_id);

-- Tool result events indexes
CREATE INDEX IF NOT EXISTS idx_tool_result_events_tool_call_id ON tool_result_events(tool_call_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_result_events_unique
  ON tool_result_events(tool_call_id, COALESCE(timestamp, ''), content, is_partial);

-- Subagent link indexes
CREATE INDEX IF NOT EXISTS idx_subagent_links_session_id ON subagent_links(session_id);
CREATE INDEX IF NOT EXISTS idx_subagent_links_message_ordinal ON subagent_links(message_ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_links_unique
  ON subagent_links(
    session_id,
    subagent_session_id,
    relationship,
    COALESCE(message_ordinal, -1)
  );

-- Turns indexes
CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_session_index ON turns(session_id, turn_index);

-- Daily token rollups.  Rows are derived from event-level token usage when
-- available, message-level usage when not, and session-level totals as a final
-- fallback for sources that only expose aggregate usage.
CREATE TABLE IF NOT EXISTS session_token_daily (
  session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder')),
  project TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  attribution TEXT NOT NULL CHECK(attribution IN ('event', 'message', 'session')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, usage_date),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_token_daily_source_date
  ON session_token_daily(source, usage_date);
CREATE INDEX IF NOT EXISTS idx_session_token_daily_project_date
  ON session_token_daily(project, usage_date);

-- ============================================================================
-- Ingest File Cursors (Phase 16 - append-only incremental sync)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ingest_file_cursors (
  source_type TEXT NOT NULL CHECK(source_type IN ('openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder')),
  file_path TEXT NOT NULL,
  session_id TEXT,
  file_size INTEGER NOT NULL,
  file_mtime TEXT,
  file_inode INTEGER,
  file_device INTEGER,
  parser_version TEXT NOT NULL,
  last_indexed_offset INTEGER NOT NULL DEFAULT 0,
  last_indexed_line INTEGER NOT NULL DEFAULT 0,
  last_message_ordinal INTEGER NOT NULL DEFAULT -1,
  last_turn_index INTEGER NOT NULL DEFAULT -1,
  last_success_at TEXT,
  last_fallback_reason TEXT,
  PRIMARY KEY (source_type, file_path),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_file_cursors_session_id
  ON ingest_file_cursors(session_id);

-- ============================================================================
-- WAL Mode (Write-Ahead Logging)
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ============================================================================
-- Schema Migrations — Phase 6: File Watcher & Sync Status
-- (Applied via runMigrations() in db/index.ts; here as canonical DDL)
-- ============================================================================

-- Sync status table: per-source tracking of sync operations
CREATE TABLE IF NOT EXISTS sync_status (
  source_type TEXT PRIMARY KEY,
  last_full_sync_at TEXT,
  last_watch_sync_at TEXT,
  files_watched INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- ============================================================================
-- Full-Text Search — FTS5 Virtual Table (Migration v9 → v10)
-- ============================================================================

-- FTS5 virtual table indexing message content for in-session search.
-- Uses external content mode (content='messages') to avoid data duplication.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages_content
USING fts5(content, content='messages', content_rowid=rowid);

-- Sync triggers keep FTS5 index aligned with messages table.
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO fts_messages_content(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO fts_messages_content(fts_messages_content, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO fts_messages_content(fts_messages_content, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO fts_messages_content(rowid, content) VALUES (new.rowid, new.content);
END;
