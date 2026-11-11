/** Synthetic, non-user fixtures derived from upstream on 2026-11-11:
 * packages/core/src/session/{sql,stored,history}.ts and packages/schema/src/session-message.ts
 * https://github.com/anomalyco/opencode/tree/dev/packages/core/src/session
 * SQL stores type separately; assistant parts precede inline content during a split migration.
 */
import Database from 'better-sqlite3';
import { createOpencodeTestDB, type TestOpencodeSession } from './opencode-test-db';

export function createOpencodeV2TestDB(options: { legacy?: TestOpencodeSession[]; splitParts?: boolean } = {}) {
  const fixture = createOpencodeTestDB(options.legacy ?? []);
  const db = new Database(fixture.dbPath);
  db.exec(`CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, fork_session_id TEXT,
    slug TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT,
    cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
    INSERT INTO session_v2 (id, directory, title, version, cost, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated)
      VALUES ('v2-parent', '/fixture/project', 'V2 fixture', '2.0.22', 0.25, 100, 20, 5, 10, 2, 1794394800000, 1794394900000);
    INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES ('v2-child', 'v2-parent', 1794394800000, 1794394900000);
    INSERT INTO session_v2 (id, fork_session_id, time_created, time_updated) VALUES ('v2-fork', 'v2-parent', 1794394800000, 1794394900000);`);
  const add = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
  add.run('msg_z', 'v2-parent', 'user', 1, 1794394800000, 1794394800000, JSON.stringify({ text: 'Find fixture needle', files: [{ name: 'example.txt', mime: 'text/plain', uri: 'media:fixture', source: { type: 'inline' } }] }));
  const content = [
    { type: 'reasoning', text: 'Inspect fixture' },
    { type: 'tool', id: 'call_fixture', name: 'bash', time: { created: 1794394801000, ran: 1794394801000, completed: 1794394801500 }, state: { status: 'completed', input: { command: 'pwd' }, content: [{ type: 'text', text: '/fixture/project' }] } },
    { type: 'tool', id: 'call_error', name: 'read', state: { status: 'error', input: { path: 'absent' }, error: { message: 'Missing fixture file' } } },
    { type: 'text', text: 'Fixture reply' },
  ];
  // Timestamp and ID ordering deliberately disagree with seq ordering.
  add.run('msg_a', 'v2-parent', 'assistant', 2, 1794394799000, 1794394802000, JSON.stringify({
    model: { id: 'gpt-5', providerID: 'openai' }, content: options.splitParts ? [{ type: 'text', text: 'Inline suffix' }] : content,
    cost: 0.25, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
  }));
  if (options.splitParts) {
    db.exec(`CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT,
      call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, PRIMARY KEY(message_id, ordinal));`);
    const insert = db.prepare('INSERT INTO session_part VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [ordinal, part] of content.entries()) insert.run('msg_a', 'v2-parent', ordinal, part.type, 'id' in part ? part.id : null, 1794394801000, 1794394802000, JSON.stringify(part));
  }
  if (!options.legacy) db.exec('DROP TABLE part; DROP TABLE message; DROP TABLE session;');
  db.close();
  return fixture;
}
