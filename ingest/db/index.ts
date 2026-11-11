/**
 * Ingest Service Database Layer
 *
 * Manages SQLite database connection, schema initialization, and lifecycle.
 * Uses better-sqlite3 for synchronous database operations.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export interface DatabaseConfig {
  path: string;
}

// ============================================================================
// Module State
// ============================================================================

export let db: Database.Database | null = null;

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Open database connection and enable WAL mode
 */
export function openDatabase(config: DatabaseConfig): Database.Database {
  if (db) {
    throw new Error('Database already open');
  }

  // Resolve path to handle relative paths
  const dbPath = path.resolve(config.path);

  // Create directory if it doesn't exist
  const dbDir = path.dirname(dbPath);
  fs.mkdir(dbDir, { recursive: true }).catch((err) => {
    logger.error(`Failed to create database directory: ${dbDir}`, err);
    throw new Error(`Failed to create database directory: ${err.message}`);
  });

  // Open database
  try {
    db = new Database(dbPath);
    logger.info(`Database opened: ${dbPath}`);
  } catch (err) {
    logger.error('Failed to open database', err);
    throw new Error(`Failed to open database: ${(err as Error).message}`);
  }

  // Enable WAL mode for better concurrency
  try {
    db.pragma('journal_mode = WAL');
    logger.debug('WAL mode enabled');
  } catch (err) {
    logger.error('Failed to enable WAL mode', err);
    throw new Error(`Failed to enable WAL mode: ${(err as Error).message}`);
  }

  return db;
}

/**
 * Initialize database schema from schema.sql file
 */
export function initSchema(): void {
  if (!db) {
    throw new Error('Database not open. Call openDatabase() first.');
  }

  // Read schema.sql file
  const schemaPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'schema.sql'
  );

  let schemaContent: string;
  try {
    schemaContent = readFileSync(schemaPath, 'utf-8');
  } catch (err) {
    logger.error(`Failed to read schema file: ${schemaPath}`, err);
    throw new Error(`Failed to read schema file: ${(err as Error).message}`);
  }

  // Execute schema
  try {
    db.exec(schemaContent);
    logger.debug('Schema initialized successfully');
  } catch (err) {
    logger.error('Failed to initialize schema', err);
    throw new Error(`Failed to initialize schema: ${(err as Error).message}`);
  }

  // Apply migrations (Phase 6: file_hash, last_sync_at)
  runMigrations();

  // Verify tables were created
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as { name: string }[];

  const expectedTables = [
    'sessions',
    'messages',
    'tool_calls',
    'tool_result_events',
    'subagent_links',
    'turns',
    'session_token_daily',
    'sync_status',
    'session_stars',
    'ingest_file_cursors',
  ];
  const missingTables = expectedTables.filter(
    (t) => !tables.find((table) => table.name === t)
  );

  if (missingTables.length > 0) {
    throw new Error(`Missing tables after schema initialization: ${missingTables.join(', ')}`);
  }

  logger.debug(`Verified ${tables.length} tables created: ${tables.map((t) => t.name).join(', ')}`);
}

/**
 * Apply schema migrations for existing databases
 *
 * Uses PRAGMA user_version to track migration state.
 * Migrations are wrapped in try/catch to gracefully handle
 * "duplicate column" errors on previously applied migrations.
 */
export function runMigrations(): void {
  if (!db) {
    throw new Error('Database not open. Call openDatabase() first.');
  }

  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  const targetVersion = 24;

  if (currentVersion >= targetVersion) {
    logger.debug(`Schema at version ${currentVersion}, no migrations needed`);
    return;
  }

  // v24 only widens source constraints. Rebuild using each existing table's
  // definition so all columns, rows, indexes and triggers are preserved.
  if (currentVersion === 23) {
    widenCommandCodeSourceConstraints(db);
    db.pragma(`user_version = ${targetVersion}`);
    return;
  }

  logger.info(`Running migrations: v${currentVersion} → v${targetVersion}`);

  // Migration 1: Add file_hash and last_sync_at columns to sessions
  // Migration 2: Add name column for session display name
  const migrationSteps: Array<{ sql: string; desc: string }> = [
    {
      desc: 'Add file_hash column to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN file_hash TEXT',
    },
    {
      desc: 'Add last_sync_at column to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN last_sync_at TEXT',
    },
    {
      desc: 'Add name column to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN name TEXT',
    },
    {
      desc: 'Invalidate skip cache to re-extract name and project',
      sql: "UPDATE sessions SET file_hash = NULL WHERE name IS NULL OR name = ''",
    },
    {
      desc: 'Invalidate stale project/name cache for repaired metadata extraction',
      sql: `
        UPDATE sessions
        SET file_hash = NULL
        WHERE name IS NULL
           OR name = ''
           OR project = 'default'
           OR project LIKE '//%'
      `,
    },
    {
      desc: 'Invalidate v4-stale metadata rows after parser cwd fixes',
      sql: `
        UPDATE sessions
        SET file_hash = NULL
        WHERE name IS NULL
           OR name = ''
           OR project = 'default'
           OR project LIKE '//%'
           OR file_path NOT LIKE '/%'
      `,
    },
    {
      desc: 'Add turn boundary columns to messages',
      sql: 'ALTER TABLE messages ADD COLUMN turn_id TEXT',
    },
    {
      desc: 'Add turn_index column to messages',
      sql: 'ALTER TABLE messages ADD COLUMN turn_index INTEGER',
    },
    {
      desc: 'Add is_real_user_input column to messages',
      sql: 'ALTER TABLE messages ADD COLUMN is_real_user_input INTEGER NOT NULL DEFAULT 0 CHECK(is_real_user_input IN (0, 1))',
    },
    {
      desc: 'Add messages turn index lookup',
      sql: 'CREATE INDEX IF NOT EXISTS idx_messages_session_turn_index ON messages(session_id, turn_index)',
    },
    {
      desc: 'Invalidate stale Claude/Codex parser cache for turn and relationship repairs',
      sql: `
        UPDATE sessions
        SET file_hash = NULL
        WHERE source IN ('claude-code', 'codex')
      `,
    },
    {
      desc: 'Add agent_name column to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN agent_name TEXT',
    },
    {
      desc: 'Add agent_name index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_sessions_agent_name ON sessions(agent_name)',
    },
    {
      desc: 'Invalidate openclaw sessions cache to backfill agent_name',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source = 'openclaw' AND agent_name IS NULL",
    },
    {
      desc: 'Create session_stars table for starred sessions',
      sql: `
        CREATE TABLE IF NOT EXISTS session_stars (
          session_id TEXT NOT NULL,
          starred_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (session_id)
        )
      `,
    },
    {
      desc: 'Create subagent_links table',
      sql: `
        CREATE TABLE IF NOT EXISTS subagent_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          subagent_session_id TEXT NOT NULL,
          subagent_source TEXT NOT NULL CHECK(subagent_source IN ('openclaw', 'claude-code', 'codex')),
          relationship TEXT NOT NULL CHECK(relationship IN ('spawned', 'attached')),
          message_ordinal INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `,
    },
    {
      desc: 'Add subagent link session index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_subagent_links_session_id ON subagent_links(session_id)',
    },
    {
      desc: 'Add subagent link message ordinal index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_subagent_links_message_ordinal ON subagent_links(message_ordinal)',
    },
    {
      desc: 'Invalidate Codex parser cache to persist subagent link anchors',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source = 'codex'",
    },
    {
      desc: 'Add total_input_tokens column to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0',
    },
    {
      desc: 'Create FTS5 virtual table for message content search',
      sql: `CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages_content
            USING fts5(content, content='messages', content_rowid=rowid)`,
    },
    {
      desc: 'Create FTS sync trigger for INSERT',
      sql: `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
              INSERT INTO fts_messages_content(rowid, content) VALUES (new.rowid, new.content);
            END`,
    },
    {
      desc: 'Create FTS sync trigger for DELETE',
      sql: `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
              INSERT INTO fts_messages_content(fts_messages_content, rowid, content)
              VALUES ('delete', old.rowid, old.content);
            END`,
    },
    {
      desc: 'Create FTS sync trigger for UPDATE',
      sql: `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
              INSERT INTO fts_messages_content(fts_messages_content, rowid, content)
              VALUES ('delete', old.rowid, old.content);
              INSERT INTO fts_messages_content(rowid, content) VALUES (new.rowid, new.content);
            END`,
    },
    {
      desc: 'Rebuild FTS5 index from existing messages',
      sql: `INSERT INTO fts_messages_content(fts_messages_content) VALUES('rebuild')`,
    },
    {
      desc: 'Invalidate skip cache to backfill total_input_tokens',
      sql: `UPDATE sessions SET file_hash = NULL WHERE total_input_tokens IS NULL OR total_input_tokens = 0`,
    },
    {
      desc: 'Create ingest file cursors table',
      sql: `
        CREATE TABLE IF NOT EXISTS ingest_file_cursors (
          source_type TEXT NOT NULL CHECK(source_type IN ('openclaw', 'claude-code', 'codex')),
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
        )
      `,
    },
    {
      desc: 'Add ingest file cursor session index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_ingest_file_cursors_session_id ON ingest_file_cursors(session_id)',
    },
    {
      desc: 'Add unique tool call idempotency index',
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_session_tool_id_unique ON tool_calls(session_id, tool_id)',
    },
    {
      desc: 'Add unique tool result event idempotency index',
      sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_result_events_unique ON tool_result_events(tool_call_id, COALESCE(timestamp, ''), content, is_partial)",
    },
    {
      desc: 'Add unique subagent link idempotency index',
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_links_unique
        ON subagent_links(
          session_id,
          subagent_session_id,
          relationship,
          COALESCE(message_ordinal, -1)
        )
      `,
    },
    {
      desc: 'Add cache read token totals to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN total_cache_read_tokens INTEGER NOT NULL DEFAULT 0',
    },
    {
      desc: 'Add cache write token totals to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN total_cache_write_tokens INTEGER NOT NULL DEFAULT 0',
    },
    {
      desc: 'Add reasoning token totals to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN total_reasoning_tokens INTEGER NOT NULL DEFAULT 0',
    },
    {
      desc: 'Add authoritative total token totals to sessions',
      sql: 'ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0',
    },
    {
      desc: 'Backfill authoritative totals from legacy input/output tokens',
      sql: `
        UPDATE sessions
        SET total_tokens = COALESCE(total_input_tokens, 0) + COALESCE(total_output_tokens, 0)
        WHERE total_tokens IS NULL OR total_tokens = 0
      `,
    },
    {
      desc: 'Invalidate parser cache to backfill source-specific token channels',
      sql: `
        UPDATE sessions
        SET file_hash = NULL
        WHERE source IN ('claude-code', 'codex')
      `,
    },
    {
      desc: 'Clean up stale rebuild tables from partial migration',
      sql: 'DROP TABLE IF EXISTS sessions_new; DROP TABLE IF EXISTS subagent_links_new; DROP TABLE IF EXISTS ingest_file_cursors_new',
    },
    {
      desc: 'Add source-reported cost column before sessions rebuild',
      sql: 'ALTER TABLE sessions ADD COLUMN source_cost_usd REAL',
    },
    {
      desc: 'Add cost source column before sessions rebuild',
      sql: 'ALTER TABLE sessions ADD COLUMN cost_source TEXT',
    },
    {
      desc: 'Add cost pricing status column before sessions rebuild',
      sql: 'ALTER TABLE sessions ADD COLUMN cost_pricing_status TEXT',
    },
    {
      desc: 'Disable foreign keys before source CHECK table rebuilds',
      sql: 'PRAGMA foreign_keys = OFF',
    },
    {
      desc: 'Rebuild sessions table with opencode + qoder CHECK + cost columns',
      sql: `
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK(source IN ('openclaw', 'claude-code', 'codex', 'opencode', 'qoder')),
          project TEXT NOT NULL,
          name TEXT,
          agent_name TEXT,
          started_at TEXT,
          ended_at TEXT,
          status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'aborted', 'error', 'unknown')),
          root_session_id TEXT,
          parent_session_id TEXT,
          relationship_type TEXT CHECK(relationship_type IN ('root', 'subagent', 'fork', 'continuation')),
          message_count INTEGER NOT NULL DEFAULT 0,
          user_message_count INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER,
          total_input_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          total_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          has_tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(has_tool_calls IN (0, 1)),
          file_path TEXT NOT NULL,
          file_size INTEGER,
          file_mtime TEXT,
          file_hash TEXT,
          last_sync_at TEXT,
          cwd TEXT,
          git_branch TEXT,
          source_session_id TEXT,
          source_version TEXT,
          parser_malformed_lines INTEGER NOT NULL DEFAULT 0,
          is_truncated INTEGER NOT NULL DEFAULT 0 CHECK(is_truncated IN (0, 1)),
          termination_status TEXT,
          source_cost_usd REAL,
          cost_source TEXT,
          cost_pricing_status TEXT,
          FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
          FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE SET NULL
        )
      `,
    },
    {
      desc: 'Copy sessions data to sessions_new',
      sql: `
        INSERT INTO sessions_new SELECT
          id, source, project, name, agent_name,
          started_at, ended_at, status,
          root_session_id, parent_session_id, relationship_type,
          message_count, user_message_count,
          total_output_tokens, total_input_tokens,
          total_cache_read_tokens, total_cache_write_tokens,
          total_reasoning_tokens, total_tokens,
          has_tool_calls,
          file_path, file_size, file_mtime, file_hash, last_sync_at,
          cwd, git_branch, source_session_id, source_version,
          parser_malformed_lines, is_truncated, termination_status,
          source_cost_usd, cost_source, cost_pricing_status
        FROM sessions
      `,
    },
    {
      desc: 'Drop FTS triggers referencing sessions before rebuild',
      sql: 'DROP TRIGGER IF EXISTS messages_fts_ai; DROP TRIGGER IF EXISTS messages_fts_ad; DROP TRIGGER IF EXISTS messages_fts_au',
    },
    {
      desc: 'Drop old sessions table',
      sql: 'DROP TABLE sessions',
    },
    {
      desc: 'Rename sessions_new to sessions',
      sql: 'ALTER TABLE sessions_new RENAME TO sessions',
    },
    {
      desc: 'Recreate FTS triggers after sessions rebuild',
      sql: `
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO fts_messages_content(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO fts_messages_content(fts_messages_content, rowid, content) VALUES('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
          INSERT INTO fts_messages_content(fts_messages_content, rowid, content) VALUES('delete', old.rowid, old.content);
          INSERT INTO fts_messages_content(rowid, content) VALUES (new.rowid, new.content);
        END
      `,
    },
    {
      desc: 'Recreate sessions indexes',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_sessions_source_project ON sessions(source, project);
        CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_root_session_id ON sessions(root_session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_agent_name ON sessions(agent_name)
      `,
    },
    {
      desc: 'Rebuild subagent_links table with opencode + qoder CHECK',
      sql: `
        CREATE TABLE subagent_links_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          subagent_session_id TEXT NOT NULL,
          subagent_source TEXT NOT NULL CHECK(subagent_source IN ('openclaw', 'claude-code', 'codex', 'opencode', 'qoder')),
          relationship TEXT NOT NULL CHECK(relationship IN ('spawned', 'attached')),
          message_ordinal INTEGER,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `,
    },
    {
      desc: 'Copy subagent_links data to subagent_links_new',
      sql: 'INSERT INTO subagent_links_new SELECT * FROM subagent_links',
    },
    {
      desc: 'Drop old subagent_links table',
      sql: 'DROP TABLE subagent_links',
    },
    {
      desc: 'Rename subagent_links_new to subagent_links',
      sql: 'ALTER TABLE subagent_links_new RENAME TO subagent_links',
    },
    {
      desc: 'Recreate subagent_links indexes',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_subagent_links_session_id ON subagent_links(session_id);
        CREATE INDEX IF NOT EXISTS idx_subagent_links_message_ordinal ON subagent_links(message_ordinal);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_links_unique
          ON subagent_links(session_id, subagent_session_id, relationship, COALESCE(message_ordinal, -1))
      `,
    },
    {
      desc: 'Rebuild ingest_file_cursors table with opencode + qoder CHECK',
      sql: `
        CREATE TABLE ingest_file_cursors_new (
          source_type TEXT NOT NULL CHECK(source_type IN ('openclaw', 'claude-code', 'codex', 'opencode', 'qoder')),
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
        )
      `,
    },
    {
      desc: 'Copy ingest_file_cursors data to ingest_file_cursors_new',
      sql: 'INSERT INTO ingest_file_cursors_new SELECT * FROM ingest_file_cursors',
    },
    {
      desc: 'Drop old ingest_file_cursors table',
      sql: 'DROP TABLE ingest_file_cursors',
    },
    {
      desc: 'Rename ingest_file_cursors_new to ingest_file_cursors',
      sql: 'ALTER TABLE ingest_file_cursors_new RENAME TO ingest_file_cursors',
    },
    {
      desc: 'Recreate ingest_file_cursors indexes',
      sql: 'CREATE INDEX IF NOT EXISTS idx_ingest_file_cursors_session_id ON ingest_file_cursors(session_id)',
    },
    {
      desc: 'Re-enable foreign keys after source CHECK table rebuilds',
      sql: 'PRAGMA foreign_keys = ON',
    },
    {
      desc: 'Invalidate skip cache for opencode and qoder migration',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source IN ('opencode', 'qoder')",
    },
    {
      desc: 'Add dashboard overview session indexes',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_sessions_source_started_at ON sessions(source, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_source_agent_name ON sessions(source, agent_name)
      `,
    },
    {
      desc: 'Invalidate Qoder parser cache to backfill plaintext history content',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source = 'qoder'",
    },
    {
      desc: 'Invalidate Qoder parser cache to strip injected user-context wrappers',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source = 'qoder'",
    },
    {
      desc: 'Invalidate Qoder parser cache to preserve injected user context as system events',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source = 'qoder'",
    },
    {
      desc: 'Clear cursors for stale Claude/Codex project labels',
      sql: `
        DELETE FROM ingest_file_cursors
        WHERE session_id IN (
          SELECT id
          FROM sessions
          WHERE (source = 'claude-code' AND project LIKE '//%')
             OR (
               source = 'codex'
               AND project GLOB '[0-9][0-9]'
               AND file_path LIKE '%/.codex/sessions/%'
             )
        )
      `,
    },
    {
      desc: 'Repair stale Claude/Codex project labels from cwd',
      sql: `
        UPDATE sessions
        SET
          project = CASE
            WHEN cwd IS NOT NULL AND trim(cwd) != '' THEN cwd
            ELSE 'default'
          END,
          file_hash = NULL
        WHERE (source = 'claude-code' AND project LIKE '//%')
           OR (
             source = 'codex'
             AND project GLOB '[0-9][0-9]'
             AND file_path LIKE '%/.codex/sessions/%'
           )
      `,
    },
    {
      desc: 'Create daily token rollup table',
      sql: `
        CREATE TABLE IF NOT EXISTS session_token_daily (
          session_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('openclaw', 'claude-code', 'codex', 'opencode', 'qoder')),
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
        )
      `,
    },
    {
      desc: 'Add daily token rollup source/date index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_session_token_daily_source_date ON session_token_daily(source, usage_date)',
    },
    {
      desc: 'Add daily token rollup project/date index',
      sql: 'CREATE INDEX IF NOT EXISTS idx_session_token_daily_project_date ON session_token_daily(project, usage_date)',
    },
    {
      desc: 'Backfill daily token rollups from session totals',
      sql: `
        INSERT OR IGNORE INTO session_token_daily (
          session_id,
          source,
          project,
          usage_date,
          attribution,
          input_tokens,
          output_tokens,
          cache_read_tokens,
          cache_write_tokens,
          reasoning_tokens,
          total_tokens
        )
        SELECT
          id,
          source,
          project,
          date(COALESCE(ended_at, started_at, file_mtime, last_sync_at)),
          'session',
          COALESCE(total_input_tokens, 0),
          COALESCE(total_output_tokens, 0),
          COALESCE(total_cache_read_tokens, 0),
          COALESCE(total_cache_write_tokens, 0),
          COALESCE(total_reasoning_tokens, 0),
          CASE
            WHEN source = 'opencode' THEN
              COALESCE(total_input_tokens, 0)
              + COALESCE(total_output_tokens, 0)
              + COALESCE(total_cache_read_tokens, 0)
              + COALESCE(total_cache_write_tokens, 0)
              + COALESCE(total_reasoning_tokens, 0)
            WHEN COALESCE(total_tokens, 0) > 0 THEN COALESCE(total_tokens, 0)
            ELSE
              COALESCE(total_input_tokens, 0)
              + COALESCE(total_output_tokens, 0)
              + COALESCE(total_cache_read_tokens, 0)
              + COALESCE(total_cache_write_tokens, 0)
              + COALESCE(total_reasoning_tokens, 0)
          END
        FROM sessions
        WHERE date(COALESCE(ended_at, started_at, file_mtime, last_sync_at)) IS NOT NULL
          AND (
            COALESCE(total_tokens, 0) > 0
            OR COALESCE(total_input_tokens, 0) > 0
            OR COALESCE(total_output_tokens, 0) > 0
            OR COALESCE(total_cache_read_tokens, 0) > 0
            OR COALESCE(total_cache_write_tokens, 0) > 0
            OR COALESCE(total_reasoning_tokens, 0) > 0
          )
          AND NOT EXISTS (
            SELECT 1
            FROM session_token_daily existing
            WHERE existing.session_id = sessions.id
          )
      `,
    },
    {
      desc: 'Invalidate Qoder parser cache to backfill calibrated token cost estimates',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source = 'qoder'",
    },
    {
      desc: 'Invalidate OpenClaw parser cache to backfill camelCase token usage',
      sql: "UPDATE sessions SET file_hash = NULL WHERE source = 'openclaw'",
    },
  ];

  for (const step of migrationSteps) {
    try {
      db.exec(step.sql);
      logger.debug(`Migration applied: ${step.desc}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('duplicate column name') || msg.includes('already exists')) {
        logger.debug(`Migration already applied: ${step.desc}`);
      } else {
        logger.error(`Migration failed: ${step.desc}: ${msg}`);
        throw err;
      }
    }
  }

  widenCommandCodeSourceConstraints(db);
  db.pragma(`user_version = ${targetVersion}`);
  logger.info(`Migrations complete — schema at v${targetVersion}`);
}

function widenCommandCodeSourceConstraints(database: Database.Database): void {
  const foreignKeys = database.pragma('foreign_keys', { simple: true });
  database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      for (const table of ['sessions', 'subagent_links', 'session_token_daily', 'ingest_file_cursors']) {
        const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
        if (!row || row.sql.includes("'commandcode'")) continue;
        const dependents = database.prepare("SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name=? AND sql IS NOT NULL ORDER BY type, name").all(table) as Array<{ sql: string }>;
        const createSql = row.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?\w+["`]?/i, `CREATE TABLE ${table}_commandcode_new`)
          .replace(/'codex'/g, "'codex', 'commandcode'");
        database.exec(createSql);
        database.exec(`INSERT INTO ${table}_commandcode_new SELECT * FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${table}_commandcode_new RENAME TO ${table}`);
        for (const dependent of dependents) database.exec(dependent.sql);
      }
      const violations = database.pragma('foreign_key_check');
      if (Array.isArray(violations) && violations.length > 0) throw new Error('Command Code source migration would violate foreign keys');
    })();
  } finally {
    database.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (!db) {
    logger.debug('Database not open, nothing to close');
    return;
  }

  try {
    db.close();
    db = null;
    logger.info('Database closed');
  } catch (err) {
    logger.error('Failed to close database', err);
    throw new Error(`Failed to close database: ${(err as Error).message}`);
  }
}

/**
 * Get active database connection
 * @throws Error if database not open
 */
export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not open. Call openDatabase() first.');
  }
  return db;
}
