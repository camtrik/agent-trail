/** Read-only adapters for OpenCode's legacy and v2 SQLite layouts. */
import Database from 'better-sqlite3';
import type { OpencodeSessionRow } from './opencode';

export type OpencodeLayout = 'legacy' | 'v2';
export interface OpencodeSchema {
  layouts: OpencodeLayout[];
  splitParts: boolean;
}
export type StoredOpencodeSession = OpencodeSessionRow & {
  storage_layout: OpencodeLayout;
  project_worktree?: string | null;
  fork_session_id?: string | null;
};

export function withOpencodeRetry<T>(fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const busy = code === 'SQLITE_BUSY'
        || (error instanceof Error && /SQLITE_BUSY|database is locked/.test(error.message));
      if (!busy) throw error;
      if (attempt >= 2) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

export function openOpencodeReadonly(dbPath: string): Database.Database {
  try {
    return withOpencodeRetry(() => {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 300 });
      db.pragma('busy_timeout = 300');
      return db;
    });
  } catch (error) {
    throw new Error(`Failed to open opencode database at ${dbPath}: ${error instanceof Error ? error.message : error}`);
  }
}

export function inspectOpencodeSchema(db: Database.Database): OpencodeSchema {
  return withOpencodeRetry(() => {
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tables = new Set(tableRows.map(row => row.name));
    const layouts: OpencodeLayout[] = [];
    const problems: string[] = [];
    const required: Record<string, string[]> = { project: ['id', 'worktree'] };
    const candidates = [
      ['legacy', ['session', 'message', 'part']],
      ['v2', ['session_v2', 'session_message']],
    ] as const;
    for (const [layout, names] of candidates) {
      if (!names.some(name => tables.has(name))) continue;
      const missing = names.filter(name => !tables.has(name));
      if (missing.length) {
        problems.push(`${layout} missing tables [${missing.join(', ')}]`);
        continue;
      }
      layouts.push(layout);
      required[names[0]] = ['id', 'project_id', 'time_created', 'time_updated'];
      required[names[1]] = ['id', 'session_id', 'time_created', 'time_updated', 'data', ...(layout === 'v2' ? ['type', 'seq'] : [])];
      if (layout === 'legacy') required.part = ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'];
    }
    if (tables.has('session_part')) required.session_part = ['message_id', 'session_id', 'ordinal', 'type', 'time_created', 'time_updated', 'data'];
    for (const [table, columns] of Object.entries(required)) {
      if (!tables.has(table)) {
        problems.push(`missing tables [${table}]`);
        continue;
      }
      const actual = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
      const missing = columns.filter(column => !actual.has(column));
      if (missing.length) problems.push(`${table} missing columns [${missing.join(', ')}]`);
    }
    if (!layouts.length || problems.length) {
      throw new Error(`OpenCode DB schema validation failed: ${problems.join('; ') || 'missing tables: expected session/message/part or session_v2/session_message'}`);
    }
    return { layouts, splitParts: tables.has('session_part') };
  });
}

export function listOpencodeSessions(
  db: Database.Database,
  schema: OpencodeSchema,
  sessionId?: string,
): StoredOpencodeSession[] {
  return withOpencodeRetry(() => {
    const sessions = new Map<string, StoredOpencodeSession>();
    // A migrated v2 copy is authoritative when both layouts contain the same ID.
    for (const layout of schema.layouts) {
      const table = layout === 'v2' ? 'session_v2' : 'session';
      const rows = db.prepare(`
        SELECT s.*, p.worktree AS project_worktree FROM ${table} s
        LEFT JOIN project p ON s.project_id = p.id${sessionId ? ' WHERE s.id = ?' : ''}
      `).all(...(sessionId ? [sessionId] : [])) as OpencodeSessionRow[];
      for (const row of rows) sessions.set(row.id, { ...row, storage_layout: layout });
    }
    return [...sessions.values()].sort((a, b) => String(b.time_updated).localeCompare(String(a.time_updated)));
  });
}

export function opencodeSessionFingerprint(db: Database.Database, row: StoredOpencodeSession, schema: OpencodeSchema): string {
  return withOpencodeRetry(() => {
    const table = row.storage_layout === 'v2' ? 'session_message' : 'message';
    const messages = db.prepare(`SELECT COUNT(*) AS count, MAX(time_updated) AS updated${row.storage_layout === 'v2' ? ', MAX(seq) AS seq' : ''} FROM ${table} WHERE session_id = ?`).get(row.id);
    const partTable = row.storage_layout === 'legacy' ? 'part' : schema.splitParts ? 'session_part' : undefined;
    const parts = partTable ? db.prepare(`SELECT COUNT(*) AS count, MAX(time_updated) AS updated FROM ${partTable} WHERE session_id = ?`).get(row.id) : null;
    return JSON.stringify([row, messages, parts]);
  });
}
