/**
 * OpenCode Sync Integration Tests
 *
 * Tests the full sync pipeline: discover → sync → canonical DB verification.
 * Uses temporary opencode.db and canonical DB instances.
 */

import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import {
  createOpencodeTestDB,
  type TestOpencodeSession,
  type TestOpencodeFixture,
} from '../parser/opencode-test-db.js';
import Database from 'better-sqlite3';
import { getConfig } from '../config';
import { turnsRoutes } from '../api/turns';
import { createOpencodeV2TestDB } from '../parser/opencode-v2-test-db';
import { syncSource } from './index.js';
import { getDatabase, closeDatabase, openDatabase, initSchema } from '../db/index.js';

const fixtures: TestOpencodeFixture[] = [];
const canonicalDirs: string[] = [];

function track(fixture: TestOpencodeFixture): TestOpencodeFixture {
  fixtures.push(fixture);
  return fixture;
}

afterAll(() => {
  for (const f of fixtures) f.cleanup();
  for (const d of canonicalDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  closeDatabase();
});

function makeSession(overrides: Partial<TestOpencodeSession> = {}): TestOpencodeSession {
  const id = randomUUID();
  return {
    id,
    slug: 'test-session',
    directory: '/test/project',
    timeCreated: '2026-05-17T10:00:00Z',
    timeUpdated: '2026-05-17T11:00:00Z',
    ...overrides,
  };
}

let parentSessionId: string;
let childSessionId: string;
let fixture: TestOpencodeFixture;

function createCanonicalDB(): void {
  const tmpDir = mkdtempSync(join(tmpdir(), 'canonical-test-'));
  canonicalDirs.push(tmpDir);
  const dbPath = join(tmpDir, 'canonical.db');

  mkdirSync(join(tmpDir), { recursive: true });
  closeDatabase();
  openDatabase({ path: dbPath });
  initSchema();
}

describe('syncOpencodeSource', () => {
  beforeAll(() => {
    parentSessionId = randomUUID();
    childSessionId = randomUUID();

    fixture = track(createOpencodeTestDB([
      makeSession({
        id: parentSessionId,
        title: 'Parent session',
        directory: '/test/project',
        cost: 1.23,
        tokensInput: 500,
        tokensOutput: 200,
        tokensReasoning: 50,
        messages: [
          {
            sessionId: parentSessionId,
            role: 'user',
            timeCreated: '2026-05-17T10:00:00Z',
            parts: [],
          },
          {
            sessionId: parentSessionId,
            role: 'assistant',
            timeCreated: '2026-05-17T10:00:01Z',
            parts: [
              {
                messageId: 'auto',
                sessionId: parentSessionId,
                type: 'text',
                data: { type: 'text', text: 'I will help you' },
                timeCreated: '2026-05-17T10:00:02Z',
              },
              {
                messageId: 'auto',
                sessionId: parentSessionId,
                type: 'tool',
                data: {
                  type: 'tool',
                  tool: 'bash',
                  callID: 'call_00_parent',
                  state: {
                    status: 'completed',
                    input: { command: 'pwd' },
                    output: '/test/project',
                  },
                },
                timeCreated: '2026-05-17T10:00:03Z',
              },
              {
                messageId: 'auto',
                sessionId: parentSessionId,
                type: 'tool',
                data: {
                  type: 'tool',
                  tool: 'read',
                  callID: 'call_01_parent',
                  state: {
                    status: 'completed',
                    input: { filePath: '/test/project/package.json' },
                    output: '{}',
                  },
                },
                timeCreated: '2026-05-17T10:00:04Z',
              },
              {
                messageId: 'auto',
                sessionId: parentSessionId,
                type: 'patch',
                data: {
                  type: 'patch',
                  hash: 'same-hash',
                  files: ['/test/project/a.ts'],
                },
                timeCreated: '2026-05-17T10:00:05Z',
              },
              {
                messageId: 'auto',
                sessionId: parentSessionId,
                type: 'patch',
                data: {
                  type: 'patch',
                  hash: 'same-hash',
                  files: ['/test/project/b.ts'],
                },
                timeCreated: '2026-05-17T10:00:06Z',
              },
            ],
          },
        ],
      }),
      makeSession({
        id: childSessionId,
        parentId: parentSessionId,
        title: 'Subagent session',
        directory: '/test/project',
        messages: [
          {
            sessionId: childSessionId,
            role: 'user',
            timeCreated: '2026-05-17T10:01:00Z',
            parts: [],
          },
          {
            sessionId: childSessionId,
            role: 'assistant',
            timeCreated: '2026-05-17T10:01:01Z',
            parts: [
              {
                messageId: 'auto',
                sessionId: childSessionId,
                type: 'text',
                data: { type: 'text', text: 'Subagent response' },
                timeCreated: '2026-05-17T10:01:02Z',
              },
            ],
          },
        ],
      }),
    ]));

    process.env.OPENCODE_DB_PATH = fixture.dbPath;
  });

  afterAll(() => {
    delete process.env.OPENCODE_DB_PATH;
  });

  beforeEach(() => {
    createCanonicalDB();
  });

  it('syncs opencode sessions into canonical DB', async () => {
    const result = await syncSource('opencode');

    expect(result.errors).toHaveLength(0);
    expect(result.sessionsInserted).toBe(2);

    const database = getDatabase();
    const parent = database.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).get(`opencode:${parentSessionId}`) as Record<string, unknown> | undefined;
    expect(parent).toBeDefined();
    expect(parent!.source).toBe('opencode');
    expect(parent!.name).toBe('Parent session');
    expect(parent!.relationship_type).toBe('root');
    expect(parent!.source_cost_usd).toBe(1.23);
    expect(parent!.cost_source).toBe('source-reported');
    expect(parent!.cost_pricing_status).toBe('priced');

    const child = database.prepare(
      'SELECT * FROM sessions WHERE id = ?'
    ).get(`opencode:${childSessionId}`) as Record<string, unknown> | undefined;
    expect(child).toBeDefined();
    expect(child!.source).toBe('opencode');
    expect(child!.name).toBe('Subagent session');
    expect(child!.parent_session_id).toBe(`opencode:${parentSessionId}`);
    expect(child!.relationship_type).toBe('subagent');

    const messages = database.prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?'
    ).get(`opencode:${parentSessionId}`) as { cnt: number };
    expect(messages.cnt).toBe(2);

    const toolCalls = database.prepare(
      'SELECT COUNT(*) as cnt FROM tool_calls WHERE session_id = ?'
    ).get(`opencode:${parentSessionId}`) as { cnt: number };
    expect(toolCalls.cnt).toBe(4);
  });

  it('is idempotent on re-sync', async () => {
    const first = await syncSource('opencode');
    expect(first.errors).toHaveLength(0);
    expect(first.sessionsInserted).toBe(2);

    const second = await syncSource('opencode');
    expect(second.errors).toHaveLength(0);

    const database = getDatabase();
    const totalSessions = database.prepare(
      "SELECT COUNT(*) as cnt FROM sessions WHERE source = 'opencode'"
    ).get() as { cnt: number };
    expect(totalSessions.cnt).toBe(2);

    const totalMessages = database.prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE source = 'opencode')"
    ).get() as { cnt: number };
    expect(totalMessages.cnt).toBe(4);

    const totalToolCalls = database.prepare(
      "SELECT COUNT(*) as cnt FROM tool_calls WHERE session_id IN (SELECT id FROM sessions WHERE source = 'opencode')"
    ).get() as { cnt: number };
    expect(totalToolCalls.cnt).toBe(4);
  });

  it('verifies subagent parent-child relationship', async () => {
    const result = await syncSource('opencode');
    expect(result.errors).toHaveLength(0);
    expect(result.sessionsInserted).toBe(2);

    const database = getDatabase();
    const child = database.prepare(
      'SELECT parent_session_id, relationship_type FROM sessions WHERE id = ?'
    ).get(`opencode:${childSessionId}`) as {
      parent_session_id: string | null;
      relationship_type: string | null;
    } | undefined;

    expect(child).toBeDefined();
    expect(child!.parent_session_id).toBe(`opencode:${parentSessionId}`);
    expect(child!.relationship_type).toBe('subagent');
  });
});


describe('OpenCode v2 sync integration', () => {
  afterEach(() => { delete process.env.OPENCODE_DB_PATH; });
  beforeEach(() => { createCanonicalDB(); });

  it('syncs mixed layouts to searchable messages, turns, tools and relationships, then skips unchanged rows', async () => {
    const f = track(createOpencodeV2TestDB({ legacy: [{ id: 'legacy-only' }], splitParts: true }));
    process.env.OPENCODE_DB_PATH = f.dbPath;
    getConfig().toolDirs.set('opencode', [f.dbPath]);
    const first = await syncSource('opencode');
    expect(first.errors).toEqual([]);
    expect(first.sessionsInserted).toBe(4);
    const db = getDatabase();
    expect(db.prepare("SELECT COUNT(*) AS n FROM fts_messages_content WHERE fts_messages_content MATCH 'needle'").get()).toEqual({ n: 1 });
    const replay = await turnsRoutes.request('/api/v1/sessions/opencode:v2-parent/turns');
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.turns).toHaveLength(1);
    expect(replayBody.turns[0].assistantMessages[0].content).toBe('Fixture reply\nInline suffix');
    expect(replayBody.turns[0].activities.filter((a: { type: string }) => a.type === 'tool_call')).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id='opencode:v2-parent'").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT parent_session_id, relationship_type FROM sessions WHERE id='opencode:v2-fork'").get()).toEqual({ parent_session_id: 'opencode:v2-parent', relationship_type: 'fork' });
    const second = await syncSource('opencode');
    expect(second.errors).toEqual([]);
    expect(second.metrics?.filesSkippedBeforeParse).toBe(4);

    // A settled tool updates in place without changing session time or row counts.
    const source = new Database(f.dbPath);
    source.prepare("UPDATE session_part SET time_updated=time_updated+10000, data=? WHERE message_id='msg_a' AND ordinal=3").run(JSON.stringify({ type: 'text', text: 'Updated fixture reply' }));
    source.close();
    const third = await syncSource('opencode');
    expect(third.errors).toEqual([]);
    expect(third.metrics?.filesParsed).toBe(1);
    expect(db.prepare("SELECT content FROM messages WHERE session_id='opencode:v2-parent' AND role='assistant'").get()).toEqual({ content: 'Updated fixture reply\nInline suffix' });
    const corrupt = new Database(f.dbPath);
    corrupt.exec("UPDATE session_message SET data='null', time_updated=time_updated+20000 WHERE id='msg_a'");
    corrupt.close();
    expect((await syncSource('opencode')).errors.join(' ')).toContain('Invalid OpenCode message JSON');
    expect(db.prepare("SELECT content FROM messages WHERE session_id='opencode:v2-parent' AND role='assistant'").get()).toEqual({ content: 'Updated fixture reply\nInline suffix' });
  });

  it('refreshes an already ingested legacy session after v2 migration with unchanged timestamps', async () => {
    const f = track(createOpencodeTestDB([{ id: 'v2-parent', title: 'Old title' }]));
    process.env.OPENCODE_DB_PATH = f.dbPath;
    getConfig().toolDirs.set('opencode', [f.dbPath]);
    expect((await syncSource('opencode')).errors).toEqual([]);
    const v2 = track(createOpencodeV2TestDB());
    const source = new Database(f.dbPath);
    source.prepare('ATTACH DATABASE ? AS upgraded').run(v2.dbPath);
    source.exec(`
      CREATE TABLE session_v2 AS SELECT * FROM upgraded.session_v2;
      CREATE TABLE session_message AS SELECT * FROM upgraded.session_message;
      UPDATE session_v2 SET time_updated=(SELECT time_updated FROM session WHERE id='v2-parent') WHERE id='v2-parent';
      DETACH DATABASE upgraded;
    `);
    source.close();
    const result = await syncSource('opencode');
    expect(result.errors).toEqual([]);
    expect(getDatabase().prepare("SELECT name FROM sessions WHERE id='opencode:v2-parent'").get()).toEqual({ name: 'V2 fixture' });
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='opencode:v2-parent'").get()).toEqual({ n: 2 });
  });
});
