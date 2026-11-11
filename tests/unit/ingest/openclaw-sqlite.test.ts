import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';
import { listOpenClawSqliteSessions, parseOpenClawSqliteSession, withOpenClawSnapshot } from '@/ingest/parser/openclaw-sqlite';
import * as config from '@/ingest/config';
import { parseOpenClawSession } from '@/ingest/parser/openclaw';
import { closeDatabase, getDatabase, initSchema, openDatabase } from '@/ingest/db';
import { syncPaths, syncSource } from '@/ingest/sync';
import { discoverOpenClawSources } from '@/ingest/sync/sources';

vi.mock('@/ingest/index', () => ({ getServiceContext: () => null }));

const fixtureDir = join(process.cwd(), 'tests/fixtures/openclaw-sqlite');
const events: Array<Record<string, unknown>> = JSON.parse(readFileSync(join(fixtureDir, 'transcript.json'), 'utf8'));
let directory: string;
let agentsDir: string;
let dbPath: string;
let writer: Database.Database;

function insertWindow(id = 'sqlite-session', key = 'agent:example:main', parentKey: string | null = null, db = writer) {
  const time = Date.parse('2026-11-10T00:00:00Z');
  db.prepare(`INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at, parent_session_key)
    VALUES (?, ?, ?, ?, ?)`).run(key, id, JSON.stringify({ sessionId: id, inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 }), time, parentKey);
  db.prepare(`INSERT INTO session_windows(session_id, session_key, created_at, updated_at, started_at, status, parent_session_key, display_name, model)
    VALUES (?, ?, ?, ?, ?, 'running', ?, 'Example session', 'example-model')`).run(id, key, time, time, time, parentKey);
}

function insertEvent(seq: number, event: Record<string, unknown>, compressed = false, sessionId = 'sqlite-session') {
  const json = JSON.stringify(event);
  const navigation = JSON.stringify({ version: 1, report: { kind: 'canonical' }, navigation: {}, reset: {}, model: {},
    modelBytes: 1, modelWithoutCheckpointBytes: 1, withoutCustomDataBytes: 1 });
  writer.prepare(`INSERT INTO transcript_events(session_id, seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sessionId, seq, compressed ? null : json,
    compressed ? zlib.zstdCompressSync(Buffer.from(json)) : null, Buffer.byteLength(json), compressed ? navigation : null, 1794268800000 + seq);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'openclaw-sqlite-'));
  agentsDir = join(directory, 'agents');
  dbPath = join(agentsDir, 'example', 'agent', 'openclaw-agent.sqlite');
  mkdirSync(join(agentsDir, 'example', 'agent'), { recursive: true });
  writer = new Database(dbPath);
  writer.pragma('foreign_keys = OFF');
  writer.exec(readFileSync(join(fixtureDir, 'schema.sql'), 'utf8'));
  insertWindow();
});

afterEach(() => {
  closeDatabase();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('OpenClaw released SQLite transcript shape', () => {
  it('preserves the legacy parser error result for a missing JSONL file', async () => {
    const result = await parseOpenClawSession(join(directory, 'missing.jsonl'), 'example');
    expect(result.session.status).toBe('error');
    expect(result.messages).toEqual([]);
    expect(result.errors).toMatchObject([{ line: 0, error: 'File does not exist' }]);
  });

  it('discovers SQLite-only agents and decodes JSON/zstd events in seq order without changing the DB', async () => {
    for (const seq of [4, 2, 0, 3, 1]) insertEvent(seq, events[seq], seq === 4);
    const before = readFileSync(dbPath);
    expect(await discoverOpenClawSources([agentsDir])).toEqual([{ type: 'openclaw', path: dbPath, sessionCount: 1 }]);
    const { result } = await parseOpenClawSqliteSession(dbPath, 'sqlite-session', 'fallback');
    expect(result.errors).toEqual([]);
    expect(result.session).toMatchObject({ id: 'sqlite-session', status: 'active', endedAt: null, cwd: '/workspace/example',
      project: '/workspace/example', sourceCostUsd: 0.03, metrics: { inputTokens: 13, outputTokens: 12, cacheReadTokens: 2, totalTokens: 27 } });
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
    expect(result.messages[3].content).toBe('The example is valid.\nNo changes needed.');
    expect(result.activities[0]).toMatchObject({ type: 'tool_call', id: 'call-1', inputJson: '{"path":"example.txt"}',
      messageOrdinal: 1, status: 'success', resultEvents: [{ content: 'Example contents.', isPartial: false }] });
    expect(readFileSync(dbPath)).toEqual(before);
    await expect(withOpenClawSnapshot(dbPath, (db) => db.prepare('DELETE FROM transcript_events').run())).rejects.toThrow(/readonly/);
  });

  it('preserves logical-session parent links and historical windows as separate transcripts', async () => {
    insertWindow('child', 'agent:example:child', 'agent:example:main');
    writer.prepare(`INSERT INTO session_windows(session_id, session_key, previous_session_id, reason, created_at, updated_at, status)
      VALUES ('older', 'agent:example:main', NULL, 'initial', 1, 2, 'done')`).run();
    insertEvent(0, events[0]);
    insertEvent(0, { ...events[0], id: 'child' }, false, 'child');
    const { result } = await parseOpenClawSqliteSession(dbPath, 'child', 'fallback');
    expect(result.session).toMatchObject({ parentSessionId: 'sqlite-session', rootSessionId: 'sqlite-session', relationshipType: 'subagent' });
    expect((await listOpenClawSqliteSessions(dbPath)).map((session) => session.id).sort()).toEqual(['child', 'older', 'sqlite-session']);
  });

  it('retains legacy and archived JSONL discovery beside SQLite', async () => {
    const sessionsDir = join(agentsDir, 'example', 'sessions');
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'legacy.jsonl'), '');
    writeFileSync(join(sessionsDir, 'archived.jsonl.reset.2026-11-10'), '');
    expect(await discoverOpenClawSources([agentsDir])).toEqual([
      { type: 'openclaw', path: dbPath, sessionCount: 1 }, { type: 'openclaw', path: sessionsDir, sessionCount: 2 },
    ]);
  });

  it('marks cold or corrupt payloads partial instead of rebuilding text from navigation', async () => {
    insertEvent(0, events[0]);
    insertEvent(1, events[1], true);
    writer.prepare('UPDATE transcript_events SET event_utf8_bytes = event_utf8_bytes + 1 WHERE seq = 1').run();
    writer.prepare(`INSERT INTO session_transcript_cold_archives(session_id,generation,archive_name,archive_sha256,event_count,raw_bytes,archive_bytes,last_seq,archived_at,storage)
      VALUES ('sqlite-session','gen-1','cold.zstd',?,5,100,50,4,1,'file')`).run('a'.repeat(64));
    const { result } = await parseOpenClawSqliteSession(dbPath, 'sqlite-session', 'fallback');
    expect(result.messages).toHaveLength(0);
    expect(result.session.metrics.isTruncated).toBe(true);
    expect(result.warnings.join(' ')).toContain('length mismatch');
    expect(result.warnings.join(' ')).toContain('Cold transcript archive');
  });

  it('never treats a navigation-only cold row as a recoverable message body', async () => {
    insertEvent(0, events[0]);
    insertEvent(1, events[1], true);
    // Simulate a reclaimed/cold payload; navigation metadata is deliberately retained.
    writer.pragma('ignore_check_constraints = ON');
    writer.prepare('UPDATE transcript_events SET event_json = NULL, event_zstd = NULL, event_utf8_bytes = NULL WHERE seq = 1').run();
    const { result } = await parseOpenClawSqliteSession(dbPath, 'sqlite-session', 'fallback');
    expect(result.messages).toEqual([]);
    expect(result.session.metrics.isTruncated).toBe(true);
    expect(result.warnings.join(' ')).toContain('Transcript body unavailable');
  });

  it('keeps compressed transcripts visibly partial when the runtime has no zstd decoder', async () => {
    insertEvent(0, events[0]);
    insertEvent(1, events[1], true);
    const descriptor = Object.getOwnPropertyDescriptor(zlib, 'zstdDecompressSync')!;
    try {
      Object.defineProperty(zlib, 'zstdDecompressSync', { ...descriptor, value: undefined });
      const { result } = await parseOpenClawSqliteSession(dbPath, 'sqlite-session', 'fallback');
      expect(result.session.metrics.isTruncated).toBe(true);
      expect(result.warnings.join(' ')).toContain('requires a Node runtime with zstd support');
      expect(result.messages).toEqual([]);
    } finally {
      Object.defineProperty(zlib, 'zstdDecompressSync', descriptor);
    }
  });

  it('recovers from an actual external SQLite writer lock', async () => {
    writer.exec('BEGIN EXCLUSIVE');
    const release = setTimeout(() => writer.exec('COMMIT'), 20);
    try {
      expect(await listOpenClawSqliteSessions(dbPath)).toEqual([{ id: 'sqlite-session', updatedAt: 1794268800000 }]);
    } finally {
      clearTimeout(release);
      if (writer.inTransaction) writer.exec('ROLLBACK');
    }
  });

  it('rejects unknown schemas with a table/column diagnostic', async () => {
    writer.exec('ALTER TABLE transcript_events RENAME COLUMN event_zstd TO unsupported_codec');
    await expect(listOpenClawSqliteSessions(dbPath)).rejects.toThrow(/Unsupported OpenClaw SQLite schema: transcript_events missing \[event_zstd\]/);
    expect((await discoverOpenClawSources([agentsDir]))[0].error).toContain('Unsupported OpenClaw SQLite schema');
  });

  it('bounds busy retries and closes each readonly connection before trying again', async () => {
    let attempts = 0;
    const value = await withOpenClawSnapshot(dbPath, () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
      return 'read';
    });
    expect(value).toBe('read');
    expect(attempts).toBe(3);
    attempts = 0;
    await expect(withOpenClawSnapshot(dbPath, () => {
      attempts++;
      throw Object.assign(new Error('still locked'), { code: 'SQLITE_BUSY' });
    })).rejects.toThrow('still locked');
    expect(attempts).toBe(3);
  });

  it('syncs mixed SQLite and JSONL archives once per ID and resyncs WAL-only appends', async () => {
    writer.pragma('journal_mode = WAL');
    for (const [seq, event] of events.entries()) insertEvent(seq, event, seq === 4);
    const sessionsDir = join(agentsDir, 'example', 'sessions');
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'sqlite-session.jsonl'), JSON.stringify({ type: 'message',
      message: { role: 'user', content: 'stale export must not win', usage: { input: 9000 } } }) + '\n');
    writeFileSync(join(sessionsDir, 'archived.jsonl.reset.2026-11-10'), JSON.stringify({ type: 'message',
      message: { role: 'user', content: 'archived transcript' } }) + '\n');
    vi.spyOn(config, 'getConfig').mockReturnValue({ ...config.loadConfig(), toolDirs: new Map([['openclaw', [agentsDir]]]) });
    openDatabase({ path: join(directory, 'ingest.db') });
    initSchema();
    expect((await discoverOpenClawSources([agentsDir])).reduce((count, source) => count + source.sessionCount, 0)).toBe(2);
    const first = await syncSource('openclaw');
    expect(first.errors).toEqual([]);
    expect(first.sessionsInserted).toBe(2);
    const db = getDatabase();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT total_tokens FROM sessions WHERE id = ?').get('sqlite-session')).toEqual({ total_tokens: 27 });
    expect(db.prepare('SELECT content FROM tool_result_events').get()).toEqual({ content: 'Example contents.' });
    const unchanged = await syncSource('openclaw');
    expect(unchanged.sessionsInserted).toBe(0);
    expect(unchanged.sessionsUpdated).toBe(0);
    insertEvent(5, { type: 'message', timestamp: '2026-11-10T00:00:05Z',
      message: { role: 'assistant', content: 'New WAL event', usage: { input: 1, output: 1, totalTokens: 2 } } });
    const changed = await syncPaths('openclaw', [dbPath + '-wal', dbPath]);
    expect(changed.errors).toEqual([]);
    expect(changed.sessionsUpdated).toBe(1);
    expect(db.prepare('SELECT message_count, total_tokens FROM sessions WHERE id = ?').get('sqlite-session'))
      .toEqual({ message_count: 5, total_tokens: 29 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tool_result_events').get()).toEqual({ n: 1 });
    const legacyChange = await syncPaths('openclaw', [join(sessionsDir, 'sqlite-session.jsonl')]);
    expect(legacyChange.sessionsUpdated).toBe(0);
    expect(db.prepare('SELECT total_tokens FROM sessions WHERE id = ?').get('sqlite-session')).toEqual({ total_tokens: 29 });
  });

  it('reports archive-only databases as partial support rather than an empty healthy source', async () => {
    writer.exec("DELETE FROM session_windows; DELETE FROM session_nodes;");
    writer.prepare(`INSERT INTO session_transcript_archives(session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,archive_name,created_at)
      VALUES ('archived-only','gen-1','agent:example:old','reset','zstd',?,?, 'archived-only.jsonl.reset.1',1)`)
      .run(Buffer.from('opaque archive body'), 'b'.repeat(64));
    const discovered = await discoverOpenClawSources([agentsDir]);
    expect(discovered[0]).toMatchObject({ sessionCount: 0, unsupportedArchiveCount: 1 });
    expect(discovered[0].warning).toContain('only exported JSONL archives are supported');
    vi.spyOn(config, 'getConfig').mockReturnValue({ ...config.loadConfig(), toolDirs: new Map([['openclaw', [agentsDir]]]) });
    openDatabase({ path: join(directory, 'ingest.db') });
    initSchema();
    const result = await syncSource('openclaw');
    expect(result.sessionsInserted).toBe(0);
    expect(result.errors.join(' ')).toContain('1 OpenClaw SQLite archive payload(s)');
    const { sourcesRoutes } = await import('@/ingest/api/sources');
    const response = await sourcesRoutes.request('http://localhost/api/v1/sources/openclaw');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sources[0]).toMatchObject({ sessionCount: 0, unsupportedArchiveCount: 1, healthStatus: 'parser-warning' });
  });

  it('reports schema incompatibility through full-source sync instead of silently skipping it', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ ...config.loadConfig(), toolDirs: new Map([['openclaw', [agentsDir]]]) });
    openDatabase({ path: join(directory, 'ingest.db') });
    initSchema();
    writer.exec('DROP TABLE transcript_events');
    const result = await syncSource('openclaw');
    expect(result.sessionsInserted).toBe(0);
    expect(result.errors.join(' ')).toContain('Unsupported OpenClaw SQLite schema');
  });


  function startCanonical() {
    vi.spyOn(config, 'getConfig').mockReturnValue({ ...config.loadConfig(), toolDirs: new Map([['openclaw', [agentsDir]]]) });
    openDatabase({ path: join(directory, 'ingest.db') });
    initSchema();
    expect(getDatabase().pragma('foreign_keys', { simple: true })).toBe(1);
  }
  function assertLineage(id: string, parent: string | null, root: string | null, kind = 'subagent') {
    expect(getDatabase().prepare('SELECT parent_session_id, root_session_id, relationship_type FROM sessions WHERE id = ?').get(id))
      .toEqual({ parent_session_id: parent, root_session_id: root, relationship_type: kind });
    expect(getDatabase().pragma('foreign_key_check')).toEqual([]);
  }
  function anotherAgent(name: string, id: string, key: string, parentKey: string | null) {
    const file = join(agentsDir, name, 'agent', 'openclaw-agent.sqlite');
    mkdirSync(join(agentsDir, name, 'agent'), { recursive: true });
    const db = new Database(file);
    try {
      db.pragma('foreign_keys = OFF');
      db.exec(readFileSync(join(fixtureDir, 'schema.sql'), 'utf8'));
      insertWindow(id, key, parentKey, db);
    } finally { db.close(); }
    return file;
  }

  it('imports child-before-parent windows and backfills both FKs in the same full sync', async () => {
    insertWindow('a-child', 'agent:example:child', 'agent:example:parent');
    insertWindow('z-parent', 'agent:example:parent');
    insertEvent(0, events[1], false, 'a-child');
    startCanonical();
    const result = await syncSource('openclaw');
    expect(result.errors).toEqual([]);
    expect(result.sessionsInserted).toBe(3);
    assertLineage('a-child', 'z-parent', 'z-parent');
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='a-child'").get()).toEqual({ n: 1 });
  });

  it('keeps orphans and restores cached lineage when a parent window arrives later', async () => {
    insertWindow('a-child', 'agent:example:child', 'agent:example:parent');
    writer.prepare(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at)
      VALUES ('agent:example:parent','z-parent','{}',1)`).run();
    startCanonical();
    expect((await syncSource('openclaw')).errors).toEqual([]);
    assertLineage('a-child', null, null);
    writer.prepare(`INSERT INTO session_windows(session_id,session_key,created_at,updated_at,status)
      VALUES ('z-parent','agent:example:parent',1,1,'done')`).run();
    const late = await syncPaths('openclaw', [dbPath + '-wal']);
    expect(late.errors).toEqual([]);
    expect(late.sessionsInserted).toBe(1);
    expect(late.sessionsUpdated).toBe(0);
    assertLineage('a-child', 'z-parent', 'z-parent');
    getDatabase().prepare("UPDATE sessions SET parent_session_id=NULL,root_session_id=NULL WHERE id='a-child'").run();
    const cached = await syncSource('openclaw');
    expect(cached.errors).toEqual([]);
    expect(cached.sessionsInserted + cached.sessionsUpdated).toBe(0);
    assertLineage('a-child', 'z-parent', 'z-parent');
  });

  it('repairs a multilevel cross-agent chain when only each late ancestor DB is synced', async () => {
    insertWindow('a-child', 'agent:example:child', 'agent:parent:main');
    startCanonical();
    expect((await syncSource('openclaw')).errors).toEqual([]);
    assertLineage('a-child', null, null);
    const parentDb = anotherAgent('parent', 'b-parent', 'agent:parent:main', 'agent:grand:main');
    expect((await syncPaths('openclaw', [parentDb])).errors).toEqual([]);
    assertLineage('a-child', 'b-parent', null);
    assertLineage('b-parent', null, null);
    const grandDb = anotherAgent('grand', 'z-grand', 'agent:grand:main', null);
    expect((await syncPaths('openclaw', [grandDb])).errors).toEqual([]);
    assertLineage('a-child', 'b-parent', 'z-grand');
    assertLineage('b-parent', 'z-grand', 'z-grand');
  });

  it('resolves a fork through an already indexed legacy JSONL ancestor', async () => {
    insertWindow('a-fork', 'agent:example:fork');
    writer.prepare("UPDATE session_windows SET reason='fork',previous_session_id='legacy-parent' WHERE session_id='a-fork'").run();
    const sessionsDir = join(agentsDir, 'example', 'sessions');
    mkdirSync(sessionsDir);
    writeFileSync(join(sessionsDir, 'legacy-parent.jsonl'), JSON.stringify(events[1]) + '\n');
    startCanonical();
    expect((await syncSource('openclaw')).errors).toEqual([]);
    assertLineage('a-fork', 'legacy-parent', 'legacy-parent', 'fork');
  });

  it('defers fork references and never links an OpenClaw child to a different source', async () => {
    insertWindow('a-fork', 'agent:example:fork');
    writer.prepare("UPDATE session_windows SET reason='fork',previous_session_id='missing-parent' WHERE session_id='a-fork'").run();
    startCanonical();
    getDatabase().prepare(`INSERT INTO sessions(id,source,project,status,file_path)
      VALUES ('missing-parent','codex','/other','idle','/other.jsonl')`).run();
    expect((await syncSource('openclaw')).errors).toEqual([]);
    assertLineage('a-fork', null, null, 'fork');
    expect(getDatabase().prepare("SELECT source, parent_session_id FROM sessions WHERE id='missing-parent'").get())
      .toEqual({ source: 'codex', parent_session_id: null });
  });

});
