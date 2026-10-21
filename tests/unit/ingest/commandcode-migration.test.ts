import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDatabase, openDatabase, runMigrations } from '@/ingest/db';
let file: string;
let opened = false;
afterEach(() => { if (opened) closeDatabase(); if (file) for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true }); });
it('upgrades existing v23 source constraints while preserving history and indexes', () => {
  file = join(tmpdir(), `commandcode-migration-${randomUUID()}.db`);
  const seed = new Database(file);
  seed.exec(readFileSync('ingest/db/schema.sql', 'utf8').replaceAll("'commandcode', ", ''));
  seed.exec("INSERT INTO sessions (id, source, project, status, file_path) VALUES ('existing', 'codex', '/repo', 'idle', '/tmp/session.jsonl'); PRAGMA user_version = 23;");
  seed.close();
  const db = openDatabase({ path: file }); opened = true;
  runMigrations();
  expect(db.prepare("SELECT id FROM sessions WHERE id='existing'").get()).toEqual({ id: 'existing' });
  expect(() => db.prepare("INSERT INTO sessions (id, source, project, status, file_path) VALUES ('new', 'commandcode', '/repo', 'idle', '/tmp/session.jsonl')").run()).not.toThrow();
  for (const table of ['sessions','subagent_links','session_token_daily','ingest_file_cursors']) {
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as {sql:string}).sql).toContain("'commandcode'");
  }
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_sessions_source_project'").get()).toBeDefined();
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
