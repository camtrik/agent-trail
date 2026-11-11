import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { parseOpencodeSession } from './opencode';
import { createOpencodeV2TestDB } from './opencode-v2-test-db';
import { discoverOpencodeSources } from '../sync/sources';
import { inspectOpencodeSchema, listOpencodeSessions, openOpencodeReadonly } from './opencode-storage';
import type { TraceToolCall } from '@/types/trace';
const fixtures: ReturnType<typeof createOpencodeV2TestDB>[] = [];
const fixture = (options?: Parameters<typeof createOpencodeV2TestDB>[0]) => { const f = createOpencodeV2TestDB(options); fixtures.push(f); return f; };
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));

describe('OpenCode v2 storage', () => {
  for (const splitParts of [false, true]) it(`parses seq-ordered v2 messages and ${splitParts ? 'split' : 'inline'} tools without duplicate usage`, async () => {
    const f = fixture({ splitParts });
    const before = readFileSync(f.dbPath);
    const result = await parseOpencodeSession(f.dbPath, 'v2-parent');
    expect(result.errors).toEqual([]);
    expect(result.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(result.messages[0].content).toBe('Find fixture needle\n[Attachment: example.txt]');
    expect(result.messages[1].content).toBe(splitParts ? 'Fixture reply\nInline suffix' : 'Fixture reply');
    expect(result.messages[1].model).toBe('gpt-5');
    expect(result.messages[1].turnIndex).toBe(0);
    expect(result.session.metrics.totalTokens).toBe(137);
    expect(result.messages[1].tokenUsage?.totalTokens).toBe(137);
    expect(result.session.sourceCostUsd).toBe(0.25);
    const calls = result.activities.filter((a): a is TraceToolCall => a.type === 'tool_call');
    expect(calls.map(call => call.status)).toEqual(['success', 'error']);
    expect(calls[0].resultEvents[0].content).toBe('/fixture/project');
    expect(calls[0].durationMs).toBe(500);
    expect(calls[1].resultEvents[0].content).toContain('Missing fixture file');
    expect(result.activities.some(a => a.type === 'thinking')).toBe(true);
    expect(readFileSync(f.dbPath)).toEqual(before);
  });

  it('discovers both layouts, preferring the v2 copy of an existing session', async () => {
    const f = fixture({ legacy: [{ id: 'old-only' }, { id: 'v2-parent', title: 'Stale legacy title' }] });
    expect((await discoverOpencodeSources([f.dbPath]))[0].sessionCount).toBe(4);
    expect((await parseOpencodeSession(f.dbPath, 'v2-parent')).session.name).toBe('V2 fixture');
    expect((await parseOpencodeSession(f.dbPath, 'old-only')).errors).toEqual([]);
  });

  it('retains parent and fork relationships and treats explicit v2 zero totals as authoritative', async () => {
    const f = fixture();
    expect((await parseOpencodeSession(f.dbPath, 'v2-child')).session.parentSessionId).toBe('opencode:v2-parent');
    const fork = (await parseOpencodeSession(f.dbPath, 'v2-fork')).session;
    expect(fork.parentSessionId).toBe('opencode:v2-parent');
    expect(fork.relationshipType).toBe('fork');
    const db = new Database(f.dbPath);
    db.exec('UPDATE session_v2 SET tokens_input=0, tokens_output=0, tokens_reasoning=0, tokens_cache_read=0, tokens_cache_write=0, cost=0');
    db.close();
    const zero = (await parseOpencodeSession(f.dbPath, 'v2-parent')).session;
    expect(zero.metrics.totalTokens).toBe(0);
    expect(zero.sourceCostUsd).toBe(0);
  });

  it('rejects partial migrations and missing seq columns with actionable diagnostics', async () => {
    const f = fixture({ legacy: [] });
    const db = new Database(f.dbPath);
    db.exec('ALTER TABLE session_message DROP COLUMN seq'); db.close();
    expect((await discoverOpencodeSources([f.dbPath]))[0].error).toContain('session_message missing columns [seq]');
    expect((await parseOpencodeSession(f.dbPath, 'v2-parent')).errors[0].error).toContain('seq');
    const db2 = new Database(f.dbPath); db2.exec('DROP TABLE session_message'); db2.close();
    expect((await discoverOpencodeSources([f.dbPath]))[0].error).toContain('v2 missing tables [session_message]');
  });

  it('opens external databases readonly with busy_timeout', () => {
    const f = fixture(); const db = openOpencodeReadonly(f.dbPath);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(300);
    expect(() => db.exec('DELETE FROM session_v2')).toThrow(/readonly/);
    expect(listOpencodeSessions(db, inspectOpencodeSchema(db))).toHaveLength(3);
    db.close();
  });

  it('keeps steered prompts in the same turn until a v2 idle marker', async () => {
    const f = fixture(); const db = new Database(f.dbPath);
    const add = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    add.run('steer', 'v2-parent', 'user', 3, 1794394803000, 1794394803000, JSON.stringify({ text: 'Steered prompt' }));
    add.run('idle', 'v2-parent', 'idle', 4, 1794394804000, 1794394804000, JSON.stringify({ outcome: 'succeeded' }));
    add.run('next', 'v2-parent', 'user', 5, 1794394805000, 1794394805000, JSON.stringify({ text: 'Next turn' }));
    db.close();
    const result = await parseOpencodeSession(f.dbPath, 'v2-parent');
    expect(result.messages.map(message => message.turnIndex)).toEqual([0, 0, 0, 0, 1]);
  });

  it('returns a bounded busy diagnostic and recovers after the writer releases its lock', async () => {
    const f = fixture(); const writer = new Database(f.dbPath);
    writer.exec('BEGIN EXCLUSIVE');
    try {
      const result = await parseOpencodeSession(f.dbPath, 'v2-parent');
      expect(result.errors[0].error).toMatch(/locked|BUSY/);
    } finally { writer.exec('ROLLBACK'); writer.close(); }
    expect((await parseOpencodeSession(f.dbPath, 'v2-parent')).errors).toEqual([]);
  });

  it('reports malformed v2 message payloads instead of accepting an empty transcript', async () => {
    const f = fixture(); const db = new Database(f.dbPath);
    db.exec("UPDATE session_message SET data='null' WHERE id='msg_z'"); db.close();
    expect((await parseOpencodeSession(f.dbPath, 'v2-parent')).errors[0].error).toBe('Invalid OpenCode message JSON');
  });

});
