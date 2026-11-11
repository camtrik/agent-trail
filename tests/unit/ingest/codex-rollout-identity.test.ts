import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CodexJsonlLine, IncrementalParseOptions } from '@/ingest/parser/types';

const timestamp = '2026-11-11T00:00:00.000Z';
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const meta = (id: string, parent?: string): CodexJsonlLine => ({
  type: 'session_meta', timestamp,
  payload: {
    id, session_id: parent || id, cwd: '/workspace',
    ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}),
  },
});
const message = (text: string): CodexJsonlLine => ({
  type: 'response_item', timestamp,
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
});
const usage = (input = 100, output = 20): CodexJsonlLine => ({
  type: 'event_msg', timestamp,
  payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    last_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
  } },
});
const options = (file: string): IncrementalParseOptions => ({
  startOffset: 0, endOffset: statSync(file).size, startLine: 0,
  startOrdinal: 0, startTurnIndex: -1, parserVersion: 'test',
});

describe('Codex physical rollout identity and metadata lineage', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codex-identity-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('keeps siblings independent in both full and initial append parsing', async () => {
    const { parseCodexSession, parseCodexSessionAppend } = await import('@/ingest/parser/codex');
    for (const id of ['child-a', 'child-b']) {
      const file = join(dir, `${id}.jsonl`);
      writeFileSync(file, jsonl([meta(id, 'shared-parent'), message(id)]));
      const full = await parseCodexSession(file, 'test');
      const append = await parseCodexSessionAppend(file, 'test', options(file));
      expect(full.session).toMatchObject({
        id, sourceSessionId: id, parentSessionId: 'shared-parent',
        rootSessionId: 'shared-parent', relationshipType: 'subagent',
      });
      expect(append.sessionId).toBe(id);
      expect(append.sessionPatch).toMatchObject({
        id, sourceSessionId: id, parentSessionId: 'shared-parent',
        rootSessionId: 'shared-parent', relationshipType: 'subagent',
      });
      expect(full.messages[0].id).toBe(`${id}-0`);
      expect(append.messages[0].id).toBe(`${id}-0`);
    }
  });

  it.each([
    { type: 'session_meta', payload: { session_id: 'legacy' } },
    { type: 'session_meta', session_meta: { session_id: 'legacy' } },
    { type: 'session_meta', payload: { id: 'legacy', session_id: 'legacy' } },
  ])('retains legacy identity and avoids self-parent links: %j', async (record) => {
    const { parseCodexSession } = await import('@/ingest/parser/codex');
    const file = join(dir, 'legacy.jsonl');
    writeFileSync(file, jsonl([record, message('legacy')]));
    const result = await parseCodexSession(file, 'test');
    expect(result.session.id).toBe('legacy');
    expect(result.session.parentSessionId).toBeUndefined();
    expect(result.session.relationshipType).toBe('root');
  });

  it('uses explicit spawn parent before session_id lineage and supports session_id-only lineage', async () => {
    const { getCodexSessionMeta } = await import('@/ingest/parser/codex-meta');
    const nested = meta('grandchild', 'parent');
    nested.payload!.session_id = 'root';
    expect(getCodexSessionMeta(nested)?.parentSessionId).toBe('parent');
    expect(getCodexSessionMeta({ type: 'session_meta', payload: { id: 'child', session_id: 'parent' } }))
      .toMatchObject({ session_id: 'child', parentSessionId: 'parent' });
    expect(getCodexSessionMeta({ type: 'session_meta', payload: { id: '', session_id: 'legacy' } }))
      .toMatchObject({ session_id: 'legacy', parentSessionId: undefined });
  });

  it('counts a repeated cumulative snapshot once in full parsing and across append boundaries', async () => {
    const { parseCodexSession, parseCodexSessionAppend } = await import('@/ingest/parser/codex');
    const file = join(dir, 'tokens.jsonl');
    writeFileSync(file, jsonl([meta('child', 'parent'), message('answer'), usage(), { ...usage(), timestamp: '2026-11-11T00:00:01.000Z' }]));
    const full = await parseCodexSession(file, 'test');
    expect(full.session.metrics.totalTokens).toBe(120);
    expect(full.tokenEvents).toHaveLength(1);
    expect(full.messages[0].tokenUsage?.totalTokens).toBe(120);
    const offset = statSync(file).size;
    appendFileSync(file, jsonl([usage()]));
    const delta = await parseCodexSessionAppend(file, 'test', {
      ...options(file), startOffset: offset, startLine: 4, sessionId: 'child',
      codexPreviousTotalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
    expect(delta.metricsDelta.totalTokens).toBe(0);
    expect(delta.tokenEvents).toEqual([]);
  });

  it('falls back when appended metadata disagrees with the physical cursor identity', async () => {
    const { parseCodexSessionAppend } = await import('@/ingest/parser/codex');
    const file = join(dir, 'changed.jsonl');
    writeFileSync(file, jsonl([meta('original'), meta('replacement')]));
    const first = Buffer.byteLength(jsonl([meta('original')]));
    const delta = await parseCodexSessionAppend(file, 'test', {
      ...options(file), startOffset: first, startLine: 1, sessionId: 'original',
    });
    expect(delta.requiresFullReparse).toBe(true);
    expect(delta.fallbackReason).toBe('session_identity_changed');
  });
});

describe('Codex identity recovery through the sync database', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), 'codex-identity-sync-'));
    dbPath = join(dir, 'ingest.db');
    process.env.INGEST_DB_PATH = dbPath;
    process.env.CODEX_SESSIONS_DIR = dir;
  });
  afterEach(async () => {
    const { closeDatabase } = await import('@/ingest/db');
    closeDatabase();
    delete process.env.INGEST_DB_PATH;
    delete process.env.CODEX_SESSIONS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  async function setup() {
    const db = await import('@/ingest/db');
    db.openDatabase({ path: dbPath });
    db.initSchema();
    return { db: db.getDatabase(), ...(await import('@/ingest/sync')) };
  }
  function rollout(name: string, id: string, parent?: string) {
    const file = join(dir, name + '.jsonl');
    writeFileSync(file, jsonl([meta(id, parent), message(id), usage()]));
    return file;
  }

  it('restores metadata-only multilevel lineage after children parse before parents, with separate append cursors', async () => {
    const { db, syncPaths } = await setup();
    const first = rollout('a-child', 'child-a', 'parent');
    const second = rollout('b-child', 'child-b', 'parent');
    const parent = rollout('y-parent', 'parent', 'root');
    const root = rollout('z-root', 'root');
    const result = await syncPaths('codex', [root, second, parent, first]);
    expect(result.errors).toEqual([]);
    expect(db.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([
      { id: 'child-a' }, { id: 'child-b' }, { id: 'parent' }, { id: 'root' },
    ]);
    for (const id of ['child-a', 'child-b']) {
      expect(db.prepare('SELECT parent_session_id, root_session_id FROM sessions WHERE id = ?').get(id))
        .toEqual({ parent_session_id: 'parent', root_session_id: 'root' });
    }
    const cursors = db.prepare('SELECT session_id, last_indexed_offset FROM ingest_file_cursors ORDER BY file_path').all();
    expect(cursors).toEqual([
      { session_id: 'child-a', last_indexed_offset: statSync(first).size },
      { session_id: 'child-b', last_indexed_offset: statSync(second).size },
      { session_id: 'parent', last_indexed_offset: statSync(parent).size },
      { session_id: 'root', last_indexed_offset: statSync(root).size },
    ]);
    appendFileSync(first, jsonl([message('only first child'), usage()]));
    const append = await syncPaths('codex', [first]);
    expect(append.errors).toEqual([]);
    expect(append.metrics?.filesParsedIncrementally).toBe(1);
    expect(db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY ordinal').all('child-a'))
      .toEqual([{ content: 'child-a' }, { content: 'only first child' }]);
    expect(db.prepare('SELECT content FROM messages WHERE session_id = ?').all('child-b')).toEqual([{ content: 'child-b' }]);
    expect(db.prepare('SELECT total_tokens FROM sessions WHERE id = ?').get('child-a')).toEqual({ total_tokens: 120 });
    expect(db.prepare('SELECT session_id, last_indexed_offset FROM ingest_file_cursors WHERE file_path = ?').get(second))
      .toEqual({ session_id: 'child-b', last_indexed_offset: statSync(second).size });
  });

  it('recovers skipped child metadata when a previously missing parent is imported later', async () => {
    const { db, syncPaths, syncSource } = await setup();
    const child = rollout('a-child', 'child', 'parent');
    expect((await syncPaths('codex', [child])).errors).toEqual([]);
    expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'child' }]);
    const parent = rollout('z-parent', 'parent');
    expect((await syncPaths('codex', [parent])).errors).toEqual([]);
    const result = await syncSource('codex');
    expect(result.errors).toEqual([]);
    expect(result.metrics?.filesParsed).toBe(0);
    expect(db.prepare('SELECT parent_session_id, root_session_id FROM sessions WHERE id = ?').get('child'))
      .toEqual({ parent_session_id: 'parent', root_session_id: 'parent' });
  });

  it('repairs old same-file identity collisions and stale cursors without changing rollouts or parent stars', async () => {
    const { db, syncPaths, writeSessionToDatabase, PARSER_CACHE_VERSION } = await setup();
    const { parseCodexSession } = await import('@/ingest/parser/codex');
    const child = rollout('a-child', 'child', 'parent');
    const bytes = readFileSync(child);
    const old = await parseCodexSession(child, 'test');
    old.session.id = 'parent';
    old.session.sourceSessionId = 'parent';
    old.session.parentSessionId = undefined;
    old.session.rootSessionId = undefined;
    old.messages.forEach((msg) => { msg.id = msg.id.replace('child-', 'parent-'); });
    expect(writeSessionToDatabase(old, db, child).errors).toEqual([]);
    db.prepare("UPDATE sessions SET file_hash = 'parser-v13-local-timezone-rollups:codex:old' WHERE id = 'parent'").run();
    db.prepare("INSERT INTO session_stars (session_id) VALUES ('parent')").run();
    db.prepare(`INSERT INTO ingest_file_cursors (
      source_type, file_path, session_id, file_size, parser_version, last_indexed_offset
    ) VALUES ('codex', ?, 'parent', ?, 'parser-v13-local-timezone-rollups', ?)`)
      .run(child, bytes.length, bytes.length);
    const result = await syncPaths('codex', [child]);
    expect(result.errors).toEqual([]);
    expect(db.prepare('SELECT id, source_session_id FROM sessions').all())
      .toEqual([{ id: 'child', source_session_id: 'child' }]);
    expect(db.prepare('SELECT session_id, parser_version FROM ingest_file_cursors').get())
      .toEqual({ session_id: 'child', parser_version: PARSER_CACHE_VERSION });
    expect(db.prepare('SELECT session_id FROM messages').all()).toEqual([{ session_id: 'child' }]);
    expect(db.prepare('SELECT session_id FROM session_stars').all()).toEqual([{ session_id: 'parent' }]);
    expect(readFileSync(child)).toEqual(bytes);
    const parent = rollout('z-parent', 'parent');
    expect((await syncPaths('codex', [parent, child], { force: true })).errors).toEqual([]);
    expect(db.prepare('SELECT id, file_path FROM sessions ORDER BY id').all())
      .toEqual([{ id: 'child', file_path: child }, { id: 'parent', file_path: parent }]);
  });

  it('collects metadata relationships during explicit maintenance scans', async () => {
    const { collectCodexRelationships } = await import('@/ingest/sync');
    rollout('child', 'child', 'parent');
    expect(await collectCodexRelationships([{ path: dir, sessionCount: 1 }]))
      .toEqual(new Map([['child', { parentSessionId: 'parent', rootSessionId: 'parent' }]]));
  });
});
