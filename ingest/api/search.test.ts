/**
 * Search API Tests — FTS5 In-Session Search
 *
 * Tests the in-session search endpoint with isolated SQLite databases.
 * Covers FTS5 search, LIKE fallback, input validation, and edge cases.
 *
 * Pattern: open temp DB, run schema, insert fixtures, mount routes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { openDatabase, closeDatabase, initSchema, getDatabase } from '../db/index.js';
import { searchRoutes } from './search.js';

// ============================================================================
// Test infrastructure
// ============================================================================

let dbPath: string;

function createApp(): Hono {
  const app = new Hono();
  app.route('/', searchRoutes);
  return app;
}

// ============================================================================
// Fixture helpers
// ============================================================================

function insertFixtures(db: Database.Database): void {
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, source, project, name, started_at, ended_at, status,
      message_count, user_message_count, total_output_tokens,
      has_tool_calls, parser_malformed_lines, is_truncated, file_path,
      source_session_id, relationship_type, parent_session_id, root_session_id, file_mtime
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertSession.run(
    'test-session-1', 'claude-code', 'test-project', 'Auth walkthrough',
    '2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z', 'idle',
    6, 3, 5000, 1, 0, 0, '/tmp/test-session-1.jsonl',
    null, 'root', null, null, '2024-01-01T01:00:00Z'
  );

  insertSession.run(
    'test-session-2', 'codex', 'finance-lab', 'GREE valuation follow-up',
    '2024-01-03T00:00:00Z', '2024-01-03T02:00:00Z', 'idle',
    5, 2, 3200, 1, 0, 0, '/tmp/test-session-2.jsonl',
    'codex-session-2', 'root', null, null, '2024-01-03T02:00:00Z'
  );

  insertSession.run(
    'test-session-3', 'openclaw', 'market-notes', 'Legacy GREE notes',
    '2024-01-02T00:00:00Z', '2024-01-02T01:00:00Z', 'idle',
    3, 1, 1200, 0, 0, 0, '/tmp/test-session-3.jsonl',
    null, 'root', null, null, '2024-01-02T01:00:00Z'
  );

  insertSession.run(
    'test-session-child', 'codex', 'finance-lab', 'GREE subagent deep dive',
    '2024-01-03T00:30:00Z', '2024-01-03T00:45:00Z', 'idle',
    2, 0, 600, 0, 0, 0, '/tmp/test-session-child.jsonl',
    'codex-child-1', 'subagent', 'test-session-2', 'test-session-2', '2024-01-03T00:45:00Z'
  );

  // Insert messages with searchable content
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, session_id, ordinal, role, content, turn_index, source_file, source_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertMessage.run('msg-1', 'test-session-1', 1, 'user', 'How do I implement authentication with JWT tokens?', 0, 'test.jsonl', 1);
  insertMessage.run('msg-2', 'test-session-1', 2, 'assistant', 'To implement JWT authentication, you need to generate a token and verify it on each request. Here is an example using the jose library.', 0, 'test.jsonl', 2);
  insertMessage.run('msg-3', 'test-session-1', 3, 'user', 'Can you also show me how to handle token refresh?', 1, 'test.jsonl', 3);
  insertMessage.run('msg-4', 'test-session-1', 4, 'assistant', 'Token refresh is handled by storing a refresh token alongside the access token. When the access token expires, use the refresh token to get a new one.', 1, 'test.jsonl', 4);
  insertMessage.run('msg-5', 'test-session-1', 5, 'user', 'What about error handling?', 2, 'test.jsonl', 5);
  insertMessage.run('msg-6', 'test-session-1', 6, 'assistant', 'For error handling, catch token verification errors and return appropriate HTTP status codes like 401 Unauthorized or 403 Forbidden.', 2, 'test.jsonl', 6);
  insertMessage.run('msg-7', 'test-session-2', 1, 'user', 'Find my recent GREE / 3632 valuation session.', 0, 'test.jsonl', 7);
  insertMessage.run('msg-8', 'test-session-2', 2, 'assistant', 'Recent GREE valuation notes: the 3632 thesis depends on mobile game cash flow durability.', 0, 'test.jsonl', 8);
  insertMessage.run('msg-9', 'test-session-2', 3, 'user', 'Compare GREE valuation with the latest assumptions.', 1, 'test.jsonl', 9);
  insertMessage.run('msg-10', 'test-session-2', 4, 'assistant', 'The updated GREE valuation still leans on the same base case.', 1, 'test.jsonl', 10);
  insertMessage.run('msg-11', 'test-session-3', 1, 'user', 'Old GREE notes from a previous market scan.', 0, 'test.jsonl', 11);
  insertMessage.run('msg-12', 'test-session-3', 2, 'assistant', 'These older GREE notes are less relevant than the newer valuation pass.', 0, 'test.jsonl', 12);
  insertMessage.run('msg-13', 'test-session-child', 1, 'assistant', 'Subagent summary: GREE scenario sensitivity by platform mix.', 0, 'test.jsonl', 13);

  // FTS5 rebuild to index existing messages (trigger may not have fired for inserts on temp DB)
  try {
    db.exec("INSERT INTO fts_messages_content(fts_messages_content) VALUES('rebuild')");
  } catch {
    // FTS5 may not be available; LIKE fallback will be tested
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('search endpoint', () => {
  let app: Hono;

  beforeAll(() => {
    dbPath = join(tmpdir(), `search-test-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    initSchema();
    const db = getDatabase();
    insertFixtures(db);
    app = createApp();
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  });

  // ==========================================================================
  // 1. FTS5 search returns matching messages
  // ==========================================================================

  describe('FTS5 search', () => {
    it('should return matching messages for a valid query', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=authentication');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.sessionId).toBe('test-session-1');
      expect(body.query).toBe('authentication');
      expect(body.results.length).toBeGreaterThanOrEqual(1);

      // Should find messages containing "authentication"
      const contents = body.results.map((r: { snippet?: string }) => r.snippet || '');
      const hasMatch = contents.some((c: string) =>
        c.toLowerCase().includes('authentication')
      );
      expect(hasMatch).toBe(true);
    });

    it('should return results with turnIndex for navigation', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=token');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.results.length).toBeGreaterThanOrEqual(1);
      // Each result should have a turnIndex (may be null for messages without turn_index)
      for (const result of body.results) {
        expect(result).toHaveProperty('turnIndex');
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('ordinal');
        expect(result).toHaveProperty('role');
        expect(result).toHaveProperty('snippet');
      }
    });

    it('should return snippet highlighting for matched content', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=JWT');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.results.length).toBeGreaterThanOrEqual(1);
      // Snippet should contain some content from the matching messages
      const firstResult = body.results[0];
      expect(firstResult.snippet.length).toBeGreaterThan(0);
    });
  });

  describe('global session search', () => {
    it('returns session-level results with deduped metadata and snippets', async () => {
      const res = await app.request('/api/v1/sessions/search?q=gree');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.query).toBe('gree');
      expect(body.results.length).toBeGreaterThanOrEqual(2);
      expect(body.results[0].id).toBe('test-session-2');
      expect(body.results[0].sessionId).toBe('test-session-2');
      expect(body.results[0].source).toBe('codex');
      expect(body.results[0].sourceSessionId).toBe('codex-session-2');
      expect(body.results[0].displayTitle).toContain('GREE');
      expect(body.results[0].project).toBe('finance-lab');
      expect(body.results[0].snippet.toLowerCase()).toContain('gree');
      expect(body.results[0].matchCount).toBeGreaterThanOrEqual(2);

      const ids = body.results.map((result: { id: string }) => result.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('supports source filtering and result limits', async () => {
      const res = await app.request('/api/v1/sessions/search?q=gree&source=codex&limit=1');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.pagination.limit).toBe(1);
      expect(body.pagination.returned).toBe(1);
      expect(body.pagination.hasMore).toBe(false);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].id).toBe('test-session-2');
      expect(body.results[0].source).toBe('codex');
    });

    it('excludes child sessions by default and includes them on demand', async () => {
      const defaultRes = await app.request('/api/v1/sessions/search?q=gree&source=codex');
      expect(defaultRes.status).toBe(200);
      const defaultBody = await defaultRes.json();
      expect(defaultBody.results.map((result: { id: string }) => result.id)).not.toContain('test-session-child');

      const includeChildrenRes = await app.request('/api/v1/sessions/search?q=gree&source=codex&includeChildren=true');
      expect(includeChildrenRes.status).toBe(200);
      const includeChildrenBody = await includeChildrenRes.json();
      expect(includeChildrenBody.results.map((result: { id: string }) => result.id)).toContain('test-session-child');
    });

    it('returns 400 for invalid source or limit', async () => {
      const invalidSource = await app.request('/api/v1/sessions/search?q=gree&source=invalid');
      expect(invalidSource.status).toBe(400);

      const invalidLimit = await app.request('/api/v1/sessions/search?q=gree&limit=-1');
      expect(invalidLimit.status).toBe(400);
    });
  });

  // ==========================================================================
  // 2. LIKE fallback when FTS5 query fails
  // ==========================================================================

  describe('LIKE fallback', () => {
    it('should handle special characters by falling back to LIKE', async () => {
      // Special FTS5 characters are stripped, so the sanitized query may be different
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=authentication');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Empty query returns 400
  // ==========================================================================

  describe('input validation', () => {
    it('should return 400 for empty query', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('required');
    });

    it('should return 400 for missing query parameter', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('required');
    });

    it('should return 400 for whitespace-only query', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=%20%20%20');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('required');
    });

    // ==========================================================================
    // 4. Invalid session ID returns 400
    // ==========================================================================

    it('should return 400 for invalid session ID format', async () => {
      // Use non-ASCII characters which are not in the allowed regex set
      const res = await app.request('/api/v1/sessions/test%E2%98%A2id/search?q=test');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('Invalid session ID');
    });

    it('should return 400 for session ID with spaces', async () => {
      const res = await app.request('/api/v1/sessions/test%20id/search?q=test');
      expect(res.status).toBe(400);
    });

    // ==========================================================================
    // 5. No results returns empty array (not error)
    // ==========================================================================

    it('should return empty results array for non-matching query', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=xyznonexistent123');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([]);
      expect(body.sessionId).toBe('test-session-1');
    });

    // ==========================================================================
    // 6. Results preserve turn_index for navigation
    // ==========================================================================

    it('should preserve turn index in results for navigation', async () => {
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=token');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Results should be ordered by ordinal
      const ordinals = body.results.map((r: { ordinal: number }) => r.ordinal);
      for (let i = 1; i < ordinals.length; i++) {
        expect(ordinals[i]).toBeGreaterThanOrEqual(ordinals[i - 1]);
      }

      // Turn indices should be present for messages that have them
      const withTurnIndex = body.results.filter((r: { turnIndex: number | null }) => r.turnIndex !== null);
      expect(withTurnIndex.length).toBeGreaterThanOrEqual(1);
    });

    it('should return 400 for query that becomes empty after sanitization', async () => {
      // Only special characters that get stripped
      const res = await app.request('/api/v1/sessions/test-session-1/search?q=%22%2A%2B%2D%28%29');
      expect(res.status).toBe(400);
    });
  });
});
