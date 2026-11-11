import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { closeDatabase, getDatabase, initSchema, openDatabase } from '@/ingest/db';

describe('ingest database migrations', () => {
  let dbPath: string | undefined;
  let openedByTest = false;

  afterEach(() => {
    if (openedByTest) {
      closeDatabase();
      openedByTest = false;
    }
    if (dbPath) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      dbPath = undefined;
    }
  });

  it('migrates v5 databases before creating turn_index-dependent indexes', () => {
    dbPath = join(tmpdir(), `ingest-v5-migration-${randomUUID()}.db`);
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('openclaw', 'claude-code', 'codex')),
        project TEXT NOT NULL,
        name TEXT,
        started_at TEXT,
        ended_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'aborted', 'error', 'unknown')),
        root_session_id TEXT,
        parent_session_id TEXT,
        relationship_type TEXT CHECK(relationship_type IN ('root', 'subagent', 'fork', 'continuation')),
        message_count INTEGER NOT NULL DEFAULT 0,
        user_message_count INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER,
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
        termination_status TEXT
      );

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool_result')),
        content TEXT NOT NULL,
        timestamp TEXT,
        model TEXT,
        has_tool_use INTEGER NOT NULL DEFAULT 0 CHECK(has_tool_use IN (0, 1)),
        token_usage_json TEXT,
        source_file TEXT NOT NULL,
        source_line INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      PRAGMA user_version = 5;
    `);
    seed.close();

    openDatabase({ path: dbPath });
    openedByTest = true;

    expect(() => initSchema()).not.toThrow();

    const db = new Database(dbPath, { readonly: true });
    const columns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    const indexes = db.prepare('PRAGMA index_list(messages)').all() as { name: string }[];
    const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const sessionIndexes = db.prepare('PRAGMA index_list(sessions)').all() as { name: string }[];
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const version = db.pragma('user_version', { simple: true });
    db.close();

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['turn_id', 'turn_index', 'is_real_user_input'])
    );
    expect(indexes.map((index) => index.name)).toContain('idx_messages_session_turn_index');
    expect(tables.map((table) => table.name)).toContain('subagent_links');
    expect(tables.map((table) => table.name)).toContain('ingest_file_cursors');
    expect(tables.map((table) => table.name)).toContain('session_token_daily');
    expect(sessionColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'total_cache_read_tokens',
        'total_cache_write_tokens',
        'total_reasoning_tokens',
        'total_tokens',
      ])
    );
    expect(sessionIndexes.map((index) => index.name)).toContain('idx_sessions_source_started_at');
    expect(sessionIndexes.map((index) => index.name)).toContain('idx_sessions_source_agent_name');
    expect(version).toBe(24);
  });

  it('initializes ingest file cursor schema idempotently', () => {
    dbPath = join(tmpdir(), `ingest-cursor-schema-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;

    expect(() => initSchema()).not.toThrow();
    expect(() => initSchema()).not.toThrow();

    const db = new Database(dbPath, { readonly: true });
    const columns = db
      .prepare('PRAGMA table_info(ingest_file_cursors)')
      .all() as { name: string }[];
    const indexes = db
      .prepare('PRAGMA index_list(ingest_file_cursors)')
      .all() as { name: string }[];
    const sessionIndexes = db
      .prepare('PRAGMA index_list(sessions)')
      .all() as { name: string }[];
    const dailyTokenIndexes = db
      .prepare('PRAGMA index_list(session_token_daily)')
      .all() as { name: string }[];
    const version = db.pragma('user_version', { simple: true });
    db.close();

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'source_type',
        'file_path',
        'session_id',
        'file_size',
        'file_mtime',
        'file_inode',
        'file_device',
        'parser_version',
        'last_indexed_offset',
        'last_indexed_line',
        'last_message_ordinal',
        'last_turn_index',
        'last_success_at',
        'last_fallback_reason',
      ])
    );
    expect(indexes.map((index) => index.name)).toContain('idx_ingest_file_cursors_session_id');
    expect(sessionIndexes.map((index) => index.name)).toContain('idx_sessions_source_started_at');
    expect(sessionIndexes.map((index) => index.name)).toContain('idx_sessions_source_agent_name');
    expect(dailyTokenIndexes.map((index) => index.name)).toContain('idx_session_token_daily_source_date');
    expect(dailyTokenIndexes.map((index) => index.name)).toContain('idx_session_token_daily_project_date');
    expect(version).toBe(24);
  });

  it('preserves existing OpenCode source cost fields when migrating from v20 to current', () => {
    dbPath = join(tmpdir(), `ingest-v20-cost-preserve-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const dbWrite = getDatabase();
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, started_at, ended_at, status,
        message_count, user_message_count,
        total_output_tokens, total_input_tokens, total_cache_read_tokens,
        total_cache_write_tokens, total_reasoning_tokens, total_tokens,
        has_tool_calls, file_path,
        source_cost_usd, cost_source, cost_pricing_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'opencode:cost-preserve',
      'opencode',
      'demo',
      '2026-01-01 00:00:00',
      '2026-01-01 00:01:00',
      'idle',
      2,
      1,
      100,
      1000,
      7000,
      0,
      300,
      8400,
      0,
      '/tmp/opencode.db#cost-preserve',
      1.23,
      'source-reported',
      'priced',
    );
    dbWrite.pragma('user_version = 20');

    closeDatabase();
    openedByTest = false;
    openDatabase({ path: dbPath });
    openedByTest = true;
    expect(() => initSchema()).not.toThrow();

    const dbRead = new Database(dbPath, { readonly: true });
    const row = dbRead.prepare(`
      SELECT source_cost_usd, cost_source, cost_pricing_status
      FROM sessions
      WHERE id = ?
    `).get('opencode:cost-preserve') as {
      source_cost_usd: number | null;
      cost_source: string | null;
      cost_pricing_status: string | null;
    };
    const version = dbRead.pragma('user_version', { simple: true });
    dbRead.close();

    expect(version).toBe(24);
    expect(row.source_cost_usd).toBeCloseTo(1.23);
    expect(row.cost_source).toBe('source-reported');
    expect(row.cost_pricing_status).toBe('priced');
  });

  it('invalidates OpenClaw parser cache when migrating from v22 to current', () => {
    dbPath = join(tmpdir(), `ingest-v22-openclaw-cache-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const dbWrite = getDatabase();
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, name, agent_name,
        started_at, ended_at, status,
        message_count, user_message_count,
        total_output_tokens, total_input_tokens,
        total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens, total_tokens,
        has_tool_calls, file_path, file_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'openclaw:camelcase-cache',
      'openclaw',
      'demo',
      'cached OpenClaw session',
      'skye',
      '2026-05-25 00:00:00',
      '2026-05-25 00:01:00',
      'idle',
      2,
      1,
      20,
      100,
      300,
      40,
      0,
      460,
      0,
      '/tmp/openclaw.jsonl',
      'old-parser-cache-key',
    );
    dbWrite.pragma('user_version = 22');

    closeDatabase();
    openedByTest = false;
    openDatabase({ path: dbPath });
    openedByTest = true;
    expect(() => initSchema()).not.toThrow();

    const dbRead = new Database(dbPath, { readonly: true });
    const row = dbRead.prepare(`
      SELECT file_hash
      FROM sessions
      WHERE id = ?
    `).get('openclaw:camelcase-cache') as { file_hash: string | null };
    const version = dbRead.pragma('user_version', { simple: true });
    dbRead.close();

    expect(version).toBe(24);
    expect(row.file_hash).toBeNull();
  });

  it('preserves existing daily token rollups when migrating from v21 to current', () => {
    dbPath = join(tmpdir(), `ingest-v21-daily-rollup-preserve-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const dbWrite = getDatabase();
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, started_at, ended_at, status,
        message_count, user_message_count,
        total_output_tokens, total_input_tokens, total_cache_read_tokens,
        total_cache_write_tokens, total_reasoning_tokens, total_tokens,
        has_tool_calls, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'codex:daily-rollup-preserve',
      'codex',
      'demo',
      '2026-05-14 00:00:00',
      '2026-05-15 00:00:00',
      'idle',
      0,
      0,
      500,
      5000,
      1000,
      0,
      200,
      5500,
      0,
      '/tmp/codex-daily-rollup.jsonl',
    );
    dbWrite.prepare(`
      INSERT INTO session_token_daily (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'codex:daily-rollup-preserve',
      'codex',
      'demo',
      '2026-05-15',
      'event',
      1000,
      100,
      200,
      0,
      50,
      1100,
    );
    dbWrite.pragma('user_version = 21');

    closeDatabase();
    openedByTest = false;
    openDatabase({ path: dbPath });
    openedByTest = true;
    expect(() => initSchema()).not.toThrow();

    const dbRead = new Database(dbPath, { readonly: true });
    const rows = dbRead.prepare(`
      SELECT usage_date, attribution, input_tokens, output_tokens, total_tokens
      FROM session_token_daily
      WHERE session_id = ?
      ORDER BY usage_date
    `).all('codex:daily-rollup-preserve') as Array<{
      usage_date: string;
      attribution: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }>;
    const version = dbRead.pragma('user_version', { simple: true });
    dbRead.close();

    expect(version).toBe(24);
    expect(rows).toEqual([
      {
        usage_date: '2026-05-15',
        attribution: 'event',
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
      },
    ]);
  });

  it('repairs stale Claude/Codex project labels during v20 migration', () => {
    dbPath = join(tmpdir(), `ingest-project-repair-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const dbWrite = new Database(dbPath);
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, file_hash, cwd, name, total_input_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'codex:date-project',
      'codex',
      '22',
      'idle',
      0,
      0,
      0,
      '/Users/example/.codex/sessions/2026/05/22/rollout.jsonl',
      'codex-hash',
      '/Users/example/Work/ai-dashboard-projects/agents-tracing-dashboard',
      'codex repair witness',
      100
    );
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, file_hash, cwd, name, total_input_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'claude:split-project',
      'claude-code',
      '//Users/example/Work/ai/dashboard/projects/agents/tracing/dashboard',
      'idle',
      0,
      0,
      0,
      '/Users/example/.claude/projects/-Users-example-Work-ai-dashboard-projects-agents-tracing-dashboard/session.jsonl',
      'claude-hash',
      '/Users/example/Work/ai-dashboard-projects/agents-tracing-dashboard',
      'claude repair witness',
      100
    );
    dbWrite.prepare(`
      INSERT INTO ingest_file_cursors (
        source_type, file_path, session_id, parser_version, file_size
      ) VALUES (?, ?, ?, ?, ?)
    `).run('codex', '/Users/example/.codex/sessions/2026/05/22/rollout.jsonl', 'codex:date-project', 'parser-v9', 100);
    dbWrite.prepare(`
      INSERT INTO ingest_file_cursors (
        source_type, file_path, session_id, parser_version, file_size
      ) VALUES (?, ?, ?, ?, ?)
    `).run('claude-code', '/Users/example/.claude/projects/-Users-example-Work-ai-dashboard-projects-agents-tracing-dashboard/session.jsonl', 'claude:split-project', 'parser-v9', 100);
    dbWrite.pragma('user_version = 19');
    dbWrite.close();

    closeDatabase();
    openedByTest = false;
    openDatabase({ path: dbPath });
    openedByTest = true;
    expect(() => initSchema()).not.toThrow();

    const dbRead = new Database(dbPath, { readonly: true });
    const rows = dbRead.prepare(`
      SELECT id, project, file_hash
      FROM sessions
      WHERE id IN ('codex:date-project', 'claude:split-project')
      ORDER BY id
    `).all() as { id: string; project: string; file_hash: string | null }[];
    const cursorCount = (
      dbRead.prepare(`
        SELECT COUNT(*) as c
        FROM ingest_file_cursors
        WHERE session_id IN ('codex:date-project', 'claude:split-project')
      `).get() as { c: number }
    ).c;
    const version = dbRead.pragma('user_version', { simple: true });
    dbRead.close();

    expect(version).toBe(24);
    expect(rows).toEqual([
      {
        id: 'claude:split-project',
        project: '/Users/example/Work/ai-dashboard-projects/agents-tracing-dashboard',
        file_hash: null,
      },
      {
        id: 'codex:date-project',
        project: '/Users/example/Work/ai-dashboard-projects/agents-tracing-dashboard',
        file_hash: null,
      },
    ]);
    expect(cursorCount).toBe(0);
  });

  it('repairs v15 databases whose source CHECK constraints only include opencode', () => {
    dbPath = join(tmpdir(), `ingest-v15-qoder-repair-${randomUUID()}.db`);
    const seed = new Database(dbPath);
    seed.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('openclaw', 'claude-code', 'codex', 'opencode')),
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
      );

      CREATE TABLE subagent_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        subagent_session_id TEXT NOT NULL,
        subagent_source TEXT NOT NULL CHECK(subagent_source IN ('openclaw', 'claude-code', 'codex', 'opencode')),
        relationship TEXT NOT NULL CHECK(relationship IN ('spawned', 'attached')),
        message_ordinal INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE ingest_file_cursors (
        source_type TEXT NOT NULL CHECK(source_type IN ('openclaw', 'claude-code', 'codex', 'opencode')),
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

      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, name, agent_name, total_input_tokens
      ) VALUES (
        'codex:legacy-parent', 'codex', 'legacy', 'idle', 1, 1,
        0, '/tmp/codex.jsonl', 'legacy parent', 'legacy-agent', 100
      );

      INSERT INTO subagent_links (
        session_id, subagent_session_id, subagent_source, relationship, message_ordinal
      ) VALUES (
        'codex:legacy-parent', 'codex:legacy-child', 'codex', 'spawned', 1
      );

      INSERT INTO ingest_file_cursors (
        source_type, file_path, session_id, parser_version, file_size
      ) VALUES (
        'codex', '/tmp/codex.jsonl', 'codex:legacy-parent', 'codex@1', 42
      );

      PRAGMA user_version = 15;
    `);
    seed.close();

    openDatabase({ path: dbPath });
    openedByTest = true;
    expect(() => initSchema()).not.toThrow();

    const dbRead = new Database(dbPath);
    const version = dbRead.pragma('user_version', { simple: true });
    const sessionSql = dbRead.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get() as { sql: string };
    const linkSql = dbRead.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='subagent_links'"
    ).get() as { sql: string };
    const cursorSql = dbRead.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='ingest_file_cursors'"
    ).get() as { sql: string };
    const legacyLinkCount = dbRead.prepare(
      `SELECT COUNT(*) as c FROM subagent_links WHERE session_id = 'codex:legacy-parent'`
    ).get() as { c: number };

    expect(version).toBe(24);
    expect(sessionSql.sql).toContain("'qoder'");
    expect(linkSql.sql).toContain("'qoder'");
    expect(cursorSql.sql).toContain("'qoder'");
    expect(legacyLinkCount.c).toBe(1);

    expect(() => {
      dbRead.prepare(`
        INSERT INTO sessions (
          id, source, project, status, message_count, user_message_count,
          has_tool_calls, file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('qoder:repair-1', 'qoder', 'demo', 'idle', 0, 0, 0, '/tmp/qoder.db');
    }).not.toThrow();
    expect(() => {
      dbRead.prepare(`
        INSERT INTO subagent_links (
          session_id, subagent_session_id, subagent_source, relationship
        ) VALUES (?, ?, ?, ?)
      `).run('qoder:repair-1', 'qoder:repair-child', 'qoder', 'spawned');
    }).not.toThrow();
    expect(() => {
      dbRead.prepare(`
        INSERT INTO ingest_file_cursors (
          source_type, file_path, parser_version, file_size
        ) VALUES (?, ?, ?, ?)
      `).run('qoder', '/tmp/qoder/local.db', 'qoder@1', 100);
    }).not.toThrow();
    dbRead.close();
  });

  it('enforces append writer idempotency constraints', () => {
    dbPath = join(tmpdir(), `ingest-append-constraints-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('session-constraints', 'codex', 'test', 'idle', 0, 0, 1, '/tmp/session.jsonl');
    db.prepare(`
      INSERT INTO tool_calls (
        session_id, message_ordinal, tool_id, name, category, input_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('session-constraints', 1, 'call-1', 'bash', 'Bash', '{}', 'pending');
    expect(() => {
      db.prepare(`
        INSERT INTO tool_calls (
          session_id, message_ordinal, tool_id, name, category, input_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('session-constraints', 1, 'call-1', 'bash', 'Bash', '{}', 'pending');
    }).toThrow();

    const toolCallId = (
      db.prepare('SELECT id FROM tool_calls WHERE session_id = ? AND tool_id = ?')
        .get('session-constraints', 'call-1') as { id: number }
    ).id;
    db.prepare(`
      INSERT INTO tool_result_events (tool_call_id, timestamp, content, is_partial)
      VALUES (?, ?, ?, ?)
    `).run(toolCallId, null, 'same output', 0);
    expect(() => {
      db.prepare(`
        INSERT INTO tool_result_events (tool_call_id, timestamp, content, is_partial)
        VALUES (?, ?, ?, ?)
      `).run(toolCallId, null, 'same output', 0);
    }).toThrow();

    db.prepare(`
      INSERT INTO subagent_links (
        session_id, subagent_session_id, subagent_source, relationship, message_ordinal
      ) VALUES (?, ?, ?, ?, ?)
    `).run('session-constraints', 'child-1', 'codex', 'spawned', null);
    expect(() => {
      db.prepare(`
        INSERT INTO subagent_links (
          session_id, subagent_session_id, subagent_source, relationship, message_ordinal
        ) VALUES (?, ?, ?, ?, ?)
      `).run('session-constraints', 'child-1', 'codex', 'spawned', null);
    }).toThrow();
    db.close();
  });

  // ====================================================================
  // Phase 18: Qoder source CHECK widening (merged into migration v15)
  // ====================================================================

  it('accepts source = qoder after migration (positive INSERT)', () => {
    dbPath = join(tmpdir(), `ingest-qoder-positive-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const db = new Database(dbPath);
    db.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('qoder:positive-1', 'qoder', 'demo', 'active', 0, 0, 0, '/tmp/qoder.db');

    const row = db.prepare(
      `SELECT id, source FROM sessions WHERE id = 'qoder:positive-1'`
    ).get() as { id: string; source: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.source).toBe('qoder');

    // Subagent link with subagent_source='qoder' must also succeed.
    db.prepare(`
      INSERT INTO subagent_links (
        session_id, subagent_session_id, subagent_source, relationship, message_ordinal
      ) VALUES (?, ?, ?, ?, ?)
    `).run('qoder:positive-1', 'qoder:child-1', 'qoder', 'spawned', null);
    const linkRow = db.prepare(
      `SELECT subagent_source FROM subagent_links WHERE session_id = 'qoder:positive-1'`
    ).get() as { subagent_source: string } | undefined;
    expect(linkRow?.subagent_source).toBe('qoder');

    // ingest_file_cursors with source_type='qoder' must also succeed.
    db.prepare(`
      INSERT INTO ingest_file_cursors (
        source_type, file_path, parser_version, file_size
      ) VALUES (?, ?, ?, ?)
    `).run('qoder', '/tmp/qoder/local.db', 'qoder@1.0.0', 1024);
    const cursorRow = db.prepare(
      `SELECT source_type FROM ingest_file_cursors WHERE source_type = 'qoder'`
    ).get() as { source_type: string } | undefined;
    expect(cursorRow?.source_type).toBe('qoder');

    db.close();
  });

  it('rejects unknown source values (qoder-typo) — CHECK still enforced', () => {
    dbPath = join(tmpdir(), `ingest-qoder-negative-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const db = new Database(dbPath);
    expect(() => {
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, status, message_count, user_message_count,
          has_tool_calls, file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('qoder-typo:1', 'qoder-typo', 'demo', 'active', 0, 0, 0, '/tmp/x.db');
    }).toThrow(/CHECK/i);

    expect(() => {
      db.prepare(`
        INSERT INTO subagent_links (
          session_id, subagent_session_id, subagent_source, relationship
        ) VALUES (?, ?, ?, ?)
      `).run('parent-x', 'child-x', 'qoder-typo', 'spawned');
    }).toThrow(/CHECK/i);

    db.close();
  });

  it('preserves rows of pre-existing sources across the v15 migration', () => {
    // Build a synthetic v13 DB by initialising the schema (which lands at v15)
    // with rows pre-inserted, then resetting user_version back to 13 and
    // re-running migrations so the v15 replacement-table step fires against
    // populated tables.
    //
    // Note on file_hash assertions: earlier (pre-v15) migrations contain
    // their own NULL-flush steps targeting source IN ('claude-code','codex')
    // that re-fire on every run from v<13. We therefore assert file_hash
    // preservation only for an openclaw row whose agent_name AND name are
    // already set, total_input_tokens > 0, and project / file_path do not
    // match any stale-metadata gate (the only openclaw flush is gated on
    // agent_name IS NULL; several earlier flushes are gated on name IS NULL
    // or total_input_tokens = 0). Row identity and source columns must
    // survive for ALL pre-existing sources.
    dbPath = join(tmpdir(), `ingest-qoder-preservation-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const dbWrite = new Database(dbPath);
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, file_hash, agent_name, name, total_input_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('codex:keep-1', 'codex', 'p1', 'idle', 5, 2, 1, '/tmp/codex.jsonl', 'codex-hash-1', null, 'codex keep 1', 100);
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, file_hash, agent_name, name, total_input_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('claude-code:keep-2', 'claude-code', 'p2', 'active', 3, 1, 0, '/tmp/cc.jsonl', 'cc-hash-2', null, 'cc keep 2', 100);
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, file_hash, agent_name, name, total_input_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('openclaw:keep-3', 'openclaw', 'p3', 'idle', 7, 3, 1, '/tmp/ow.jsonl', 'ow-hash-3', 'preset-agent', 'ow keep 3', 100);
    dbWrite.prepare(`
      INSERT INTO subagent_links (
        session_id, subagent_session_id, subagent_source, relationship
      ) VALUES (?, ?, ?, ?)
    `).run('codex:keep-1', 'codex:child-keep', 'codex', 'spawned');
    dbWrite.prepare(`
      INSERT INTO ingest_file_cursors (
        source_type, file_path, parser_version, file_size
      ) VALUES (?, ?, ?, ?)
    `).run('codex', '/tmp/codex.jsonl', 'codex@1', 999);
    // Sanity probe: confirm pre-migration state has the rows we expect.
    const preLinks = dbWrite.prepare('SELECT COUNT(*) as c FROM subagent_links').get() as { c: number };
    const preCursors = dbWrite.prepare('SELECT COUNT(*) as c FROM ingest_file_cursors').get() as { c: number };
    expect(preLinks.c).toBeGreaterThan(0);
    expect(preCursors.c).toBeGreaterThan(0);
    // Force a re-run of migrations including the v15 replacement step.
    dbWrite.pragma('user_version = 13');
    dbWrite.close();

    // closeDatabase() is required because runMigrations() uses the
    // module-level `db` handle opened by initSchema() above. Reopen via the
    // public API and rerun runMigrations indirectly through initSchema.
    closeDatabase();
    openedByTest = false;
    openDatabase({ path: dbPath });
    openedByTest = true;
    expect(() => initSchema()).not.toThrow();

    const dbRead = new Database(dbPath, { readonly: true });
    const sessionRows = dbRead.prepare(
      `SELECT id, source, file_hash FROM sessions ORDER BY id`
    ).all() as { id: string; source: string; file_hash: string | null }[];
    const linkRows = dbRead.prepare(
      `SELECT session_id, subagent_source FROM subagent_links`
    ).all() as { session_id: string; subagent_source: string }[];
    const cursorRows = dbRead.prepare(
      `SELECT source_type, file_path FROM ingest_file_cursors`
    ).all() as { source_type: string; file_path: string }[];
    const version = dbRead.pragma('user_version', { simple: true });
    dbRead.close();

    expect(version).toBe(24);
    // All three pre-existing rows survive the rebuild.
    const ids = sessionRows.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining(['codex:keep-1', 'claude-code:keep-2', 'openclaw:keep-3'])
    );
    const codexRow = sessionRows.find((r) => r.id === 'codex:keep-1');
    const ccRow = sessionRows.find((r) => r.id === 'claude-code:keep-2');
    const owRow = sessionRows.find((r) => r.id === 'openclaw:keep-3');
    expect(codexRow?.source).toBe('codex');
    expect(ccRow?.source).toBe('claude-code');
    expect(owRow?.source).toBe('openclaw');
    // openclaw row with agent_name preset survives the rebuild; v23
    // intentionally invalidates its parser cache to backfill real token usage.
    expect(owRow?.file_hash).toBeNull();
    // Subagent_links rows preserved through the rebuild.
    expect(linkRows.map((r) => r.session_id)).toContain('codex:keep-1');
    expect(linkRows.map((r) => r.subagent_source)).toContain('codex');
    // ingest_file_cursors rows preserved through the rebuild.
    expect(cursorRows.map((r) => r.source_type)).toContain('codex');
  });

  it('NULL-flushes file_hash for qoder and OpenClaw parser-cache migrations', () => {
    dbPath = join(tmpdir(), `ingest-qoder-flush-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    openedByTest = true;
    initSchema();

    const dbWrite = new Database(dbPath);
    // Insert one row per source with a non-NULL file_hash (allowed because
    // initSchema already brought us to current schema with widened CHECKs).
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, file_hash, agent_name, name, total_input_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('qoder:flush-1', 'qoder', 'demo', 'idle', 0, 0, 0, '/tmp/q.db', 'qoder-fp-PRE', null, 'qoder flush witness', 100);
    dbWrite.prepare(`
      INSERT INTO sessions (
        id, source, project, status, message_count, user_message_count,
        has_tool_calls, file_path, file_hash, agent_name, name, total_input_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('openclaw:flush-witness', 'openclaw', 'demo', 'idle', 0, 0, 0, '/tmp/ow.jsonl', 'ow-fp-PRE', 'preset-agent', 'ow flush witness', 100);
    // Reset user_version so re-running migrations re-applies v15 (including
    // the own-source NULL-flush step).
    dbWrite.pragma('user_version = 13');
    dbWrite.close();

    closeDatabase();
    openedByTest = false;
    openDatabase({ path: dbPath });
    openedByTest = true;
    expect(() => initSchema()).not.toThrow();

    const dbRead = new Database(dbPath, { readonly: true });
    const qoderRow = dbRead.prepare(
      `SELECT file_hash FROM sessions WHERE id = 'qoder:flush-1'`
    ).get() as { file_hash: string | null } | undefined;
    const owRow = dbRead.prepare(
      `SELECT file_hash FROM sessions WHERE id = 'openclaw:flush-witness'`
    ).get() as { file_hash: string | null } | undefined;
    dbRead.close();

    // qoder row: file_hash NULL'd by the v15 own-source flush step.
    expect(qoderRow?.file_hash).toBeNull();
    // openclaw row: file_hash NULL'd by the v23 token-usage backfill step.
    expect(owRow?.file_hash).toBeNull();
  });
});
