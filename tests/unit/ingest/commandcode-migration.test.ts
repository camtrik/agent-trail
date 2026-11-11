import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDatabase, openDatabase, runMigrations, initSchema } from '@/ingest/db';

let file: string;
afterEach(() => {
  closeDatabase();
  if (file) for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});
const sourceTables = ['sessions', 'subagent_links', 'session_token_daily', 'ingest_file_cursors'];

it('upgrades v23 while preserving dependent history, indexes, triggers, foreign keys and repeat startup', () => {
  file = join(tmpdir(), `commandcode-migration-${randomUUID()}.db`);
  const seed = new Database(file);
  seed.exec(readFileSync('ingest/db/schema.sql', 'utf8').replaceAll("'commandcode', ", ''));
  seed.exec(`
    CREATE TABLE session_stars (session_id TEXT NOT NULL PRIMARY KEY, starred_at TEXT NOT NULL DEFAULT (datetime('now')));
    PRAGMA foreign_keys=ON;
    INSERT INTO sessions (id, source, project, status, file_path) VALUES ('existing', 'codex', '/repo', 'idle', '/tmp/session.jsonl');
    INSERT INTO messages (id, session_id, ordinal, role, content) VALUES ('message', 'existing', 0, 'user', 'migration needle');
    INSERT INTO tool_calls (id, session_id, message_ordinal, tool_id, name, input_json, status)
      VALUES (1, 'existing', 0, 'call', 'read', '{}', 'success');
    INSERT INTO tool_result_events (tool_call_id, content) VALUES (1, 'preserved result');
    INSERT INTO subagent_links (session_id, subagent_session_id, subagent_source, relationship)
      VALUES ('existing', 'child', 'codex', 'spawned');
    INSERT INTO session_token_daily (session_id, source, project, usage_date, attribution, input_tokens, total_tokens)
      VALUES ('existing', 'codex', '/repo', '2026-11-11', 'message', 5, 5);
    INSERT INTO ingest_file_cursors (source_type, file_path, session_id, file_size, parser_version)
      VALUES ('codex', '/tmp/session.jsonl', 'existing', 10, 'fixture');
    CREATE INDEX custom_sessions_name ON sessions(name);
    CREATE TABLE migration_audit (session_id TEXT);
    CREATE TRIGGER custom_session_audit AFTER INSERT ON sessions BEGIN
      INSERT INTO migration_audit VALUES (new.id);
    END;
    PRAGMA user_version=23;
  `);
  const before = sourceTables.map(table => seed.prepare(`SELECT * FROM ${table}`).all());
  seed.close();

  let db = openDatabase({ path: file });
  db.pragma('foreign_keys=ON');
  initSchema();
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('user_version', { simple: true })).toBe(24);
  expect(sourceTables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  expect(db.prepare('SELECT content FROM tool_result_events').get()).toEqual({ content: 'preserved result' });
  expect(db.prepare("SELECT COUNT(*) AS n FROM fts_messages_content WHERE fts_messages_content MATCH 'needle'").get()).toEqual({ n: 1 });
  for (const name of ['idx_sessions_source_project', 'custom_sessions_name', 'custom_session_audit']) {
    expect(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name)).toEqual({ name });
  }
  db.prepare("INSERT INTO sessions (id, source, project, status, file_path) VALUES ('new', 'commandcode', '/repo', 'idle', '/tmp/new.jsonl')").run();
  expect(db.prepare('SELECT * FROM migration_audit').all()).toEqual([{ session_id: 'new' }]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  closeDatabase();

  db = openDatabase({ path: file });
  initSchema(); runMigrations();
  expect(db.pragma('user_version', { simple: true })).toBe(24);
  expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
  expect(db.pragma('foreign_key_check')).toEqual([]);
  for (const table of sourceTables) {
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as { sql: string }).sql).toContain("'commandcode'");
  }
  db.pragma('foreign_keys=ON');
  db.prepare("DELETE FROM sessions WHERE id='existing'").run();
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM tool_result_events').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT session_id FROM ingest_file_cursors').get()).toEqual({ session_id: null });
});

it('uses the same source constraints on every fresh canonical table', () => {
  file = join(tmpdir(), `commandcode-fresh-${randomUUID()}.db`);
  const db = openDatabase({ path: file }); initSchema();
  db.exec(`
    INSERT INTO sessions (id, source, project, status, file_path) VALUES ('new', 'commandcode', '/repo', 'idle', '/tmp/new.jsonl');
    INSERT INTO subagent_links (session_id, subagent_session_id, subagent_source, relationship) VALUES ('new', 'child', 'commandcode', 'spawned');
    INSERT INTO session_token_daily (session_id, source, project, usage_date, attribution) VALUES ('new', 'commandcode', '/repo', '2026-11-11', 'message');
    INSERT INTO ingest_file_cursors (source_type, file_path, session_id, file_size, parser_version) VALUES ('commandcode', '/tmp/new.jsonl', 'new', 0, 'fixture');
  `);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('user_version', { simple: true })).toBe(24);
});

function seedV23GlobalDependents(kind: 'view' | 'cross-table-trigger' | 'both'): void {
  file = join(tmpdir(), `commandcode-dependents-${randomUUID()}.db`);
  const seed = new Database(file);
  seed.exec(readFileSync('ingest/db/schema.sql', 'utf8').replaceAll("'commandcode', ", ''));
  seed.exec(`
    CREATE TABLE session_stars (session_id TEXT NOT NULL PRIMARY KEY, starred_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO sessions (id, source, project, status, file_path)
      VALUES ('existing', 'codex', '/repo', 'active', '/tmp/session.jsonl');
    PRAGMA user_version=23;
  `);
  if (kind === 'view' || kind === 'both') seed.exec(`
    CREATE VIEW active_source_sessions AS SELECT id FROM sessions WHERE status='active';
    CREATE VIEW nested_source_sessions AS SELECT id FROM active_source_sessions;
  `);
  if (kind === 'cross-table-trigger' || kind === 'both') seed.exec(`
    CREATE TABLE cross_table_audit (id TEXT);
    CREATE TRIGGER cross_table_trigger AFTER INSERT ON messages BEGIN
      INSERT INTO cross_table_audit SELECT id FROM sessions WHERE id=new.session_id;
    END;
  `);
  seed.close();
}

const dependencySql = (db: Database.Database) => db.prepare(`
  SELECT type, name, sql FROM sqlite_master
  WHERE name IN ('active_source_sessions', 'nested_source_sessions', 'cross_table_trigger')
  ORDER BY name
`).all();

it.each(['view', 'cross-table-trigger'] as const)(
  'preserves global %s references through a v23 rebuild and repeat startup',
  (kind) => {
    seedV23GlobalDependents(kind);
    const db = openDatabase({ path: file });
    db.pragma('foreign_keys=ON');
    db.pragma('legacy_alter_table=OFF');
    const definitions = dependencySql(db);

    initSchema();
    expect(db.pragma('user_version', { simple: true })).toBe(24);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('legacy_alter_table', { simple: true })).toBe(0);
    expect(dependencySql(db)).toEqual(definitions);
    if (kind === 'view') {
      expect(db.prepare('SELECT * FROM nested_source_sessions').all()).toEqual([{ id: 'existing' }]);
    } else {
      db.prepare("INSERT INTO messages (id, session_id, ordinal, role, content) VALUES ('after', 'existing', 0, 'user', 'after migration')").run();
      expect(db.prepare('SELECT * FROM cross_table_audit').all()).toEqual([{ id: 'existing' }]);
    }
    initSchema(); runMigrations();
    expect(dependencySql(db)).toEqual(definitions);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  },
);

it.each([[0, 0], [0, 1], [1, 0], [1, 1]])('restores foreign_keys=%i / legacy_alter_table=%i after failure and safe retry', (foreignKeys, legacy) => {
  seedV23GlobalDependents('both');
  const db = openDatabase({ path: file });
  db.pragma('foreign_keys=OFF');
  db.exec("INSERT INTO messages (id, session_id, ordinal, role, content) VALUES ('orphan', 'missing', 0, 'user', 'invalid fixture')");
  db.pragma(`foreign_keys=${foreignKeys}`);
  db.pragma(`legacy_alter_table=${legacy}`);
  const schemaBefore = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
  const rowsBefore = [...sourceTables, 'messages', 'cross_table_audit'].map(table => db.prepare(`SELECT * FROM ${table}`).all());

  expect(() => runMigrations()).toThrow('Command Code source migration would violate foreign keys');
  expect(db.pragma('user_version', { simple: true })).toBe(23);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeys);
  expect(db.pragma('legacy_alter_table', { simple: true })).toBe(legacy);
  expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(schemaBefore);
  expect([...sourceTables, 'messages', 'cross_table_audit'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(rowsBefore);
  expect(db.prepare('SELECT * FROM nested_source_sessions').all()).toEqual([{ id: 'existing' }]);

  db.prepare("DELETE FROM messages WHERE id='orphan'").run();
  runMigrations(); runMigrations();
  expect(db.pragma('user_version', { simple: true })).toBe(24);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(foreignKeys);
  expect(db.pragma('legacy_alter_table', { simple: true })).toBe(legacy);
  expect(dependencySql(db)).toEqual(schemaBefore.filter((row) => {
    const name = (row as { name: string }).name;
    return ['active_source_sessions', 'nested_source_sessions', 'cross_table_trigger'].includes(name);
  }).sort((a, b) => (a as { name: string }).name.localeCompare((b as { name: string }).name)));
  db.prepare("INSERT INTO messages (id, session_id, ordinal, role, content) VALUES ('retried', 'existing', 0, 'user', 'after retry')").run();
  expect(db.prepare('SELECT * FROM cross_table_audit').all()).toEqual([{ id: 'existing' }]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_commandcode_new'").all()).toEqual([]);
});
