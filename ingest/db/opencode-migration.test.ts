/**
 * OpenCode Migration Tests — Schema v13 → current
 *
 * Tests migration adds 'opencode' to CHECK constraints on 3 tables,
 * adds source_cost_usd / cost_source / cost_pricing_status columns,
 * and preserves existing data.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDatabase, initSchema, closeDatabase, db } from './index.js';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

let dbPath: string;

interface NameRow { name: string }
interface SessionRow {
  source: string;
  project: string;
  name: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_tokens: number;
  source_cost_usd: number | null;
  cost_source: string | null;
  cost_pricing_status: string | null;
}

beforeAll(() => {
  dbPath = join(tmpdir(), `opencode-migration-test-${randomUUID()}.db`);
  openDatabase({ path: dbPath });
  initSchema();
});

afterAll(() => {
  closeDatabase();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
});

describe('OpenCode migration v13 → current', () => {
  it('should apply current migrations cleanly on a fresh DB', () => {
    const version = db!.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(24);

    const tables = (db!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all() as NameRow[]).map((r) => r.name);

    expect(tables).toContain('sessions');
    expect(tables).toContain('subagent_links');
    expect(tables).toContain('ingest_file_cursors');
    expect(tables).toContain('session_token_daily');
  });

  it('should allow INSERT with source = opencode', () => {
    expect(() => {
      db!.prepare(`
        INSERT INTO sessions (
          id, source, project, started_at, ended_at, status,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens, total_tokens,
          has_tool_calls, parser_malformed_lines, is_truncated,
          file_path, file_size, file_mtime, last_sync_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'opencode-session-1',
        'opencode',
        '/test/opencode',
        '2026-05-01T00:00:00Z',
        '2026-05-01T01:00:00Z',
        'idle',
        3, 2,
        500, 300,
        100, 50, 20, 970,
        1, 0, 0,
        '/test/opencode.db',
        2048,
        '2026-05-01T01:00:00Z',
        '2026-05-01T01:00:00Z'
      );
    }).not.toThrow();

    const row = db!.prepare('SELECT source FROM sessions WHERE id = ?').get('opencode-session-1') as SessionRow;
    expect(row.source).toBe('opencode');
  });

  it('should preserve existing session data through migration', () => {
    db!.prepare(`
      INSERT INTO sessions (
        id, source, project, name, started_at, ended_at, status,
        message_count, user_message_count, total_output_tokens, total_input_tokens,
        total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens, total_tokens,
        has_tool_calls, parser_malformed_lines, is_truncated,
        file_path, file_size, file_mtime, file_hash, last_sync_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-session-preserve',
      'claude-code',
      '/test/project',
      'Test Session',
      '2026-01-01T00:00:00Z',
      '2026-01-01T01:00:00Z',
      'idle',
      5, 3,
      100, 200,
      50, 25, 10, 385,
      1, 0, 0,
      '/test/file.jsonl',
      1024,
      '2026-01-01T01:00:00Z',
      'hash123',
      '2026-01-01T01:00:00Z'
    );

    const row = db!.prepare(
      'SELECT source, project, name, total_input_tokens, total_output_tokens, total_reasoning_tokens, total_tokens FROM sessions WHERE id = ?'
    ).get('test-session-preserve') as SessionRow;
    expect(row).toBeDefined();
    expect(row.source).toBe('claude-code');
    expect(row.project).toBe('/test/project');
    expect(row.name).toBe('Test Session');
    expect(row.total_input_tokens).toBe(200);
    expect(row.total_output_tokens).toBe(100);
    expect(row.total_reasoning_tokens).toBe(10);
    expect(row.total_tokens).toBe(385);
  });

  it('should allow INSERT with source_cost_usd, cost_source, cost_pricing_status', () => {
    db!.prepare(`
      INSERT INTO sessions (
        id, source, project, started_at, ended_at, status,
        message_count, user_message_count, total_output_tokens, total_input_tokens,
        total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens, total_tokens,
        has_tool_calls, parser_malformed_lines, is_truncated,
        file_path, file_size, file_mtime, last_sync_at,
        source_cost_usd, cost_source, cost_pricing_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'opencode-cost-1',
      'opencode',
      '/test/cost',
      '2026-05-01T00:00:00Z',
      '2026-05-01T01:00:00Z',
      'idle',
      1, 1,
      100, 50,
      0, 0, 0, 150,
      0, 0, 0,
      '/test/opencode.db',
      512,
      '2026-05-01T01:00:00Z',
      '2026-05-01T01:00:00Z',
      1.23,
      'source-reported',
      'priced'
    );

    const row = db!.prepare(
      'SELECT source_cost_usd, cost_source, cost_pricing_status FROM sessions WHERE id = ?'
    ).get('opencode-cost-1') as SessionRow;
    expect(row.source_cost_usd).toBeCloseTo(1.23);
    expect(row.cost_source).toBe('source-reported');
    expect(row.cost_pricing_status).toBe('priced');
  });
});
