/**
 * Read-only OpenClaw v2026.11.3 transcript adapter.
 * Contract: https://github.com/openclaw/openclaw/blob/v2026.11.3/src/state/openclaw-agent-schema.sql
 * Codec: src/config/sessions/transcript-payload.ts at the same release.
 * Only the session/transcript tables below are read; auth and cache tables are never queried.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseOpenClawRecords } from './openclaw';
import type { ParseResult } from './types';
import type { TraceToolCall } from '@/types/trace';

export const OPENCLAW_DATABASE_NAME = 'openclaw-agent.sqlite';
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const REQUIRED_COLUMNS: Record<string, string[]> = {
  session_nodes: ['session_key', 'current_session_id', 'entry_json', 'parent_session_key'],
  session_windows: ['session_id', 'session_key', 'previous_session_id', 'reason', 'created_at',
    'updated_at', 'started_at', 'ended_at', 'status', 'parent_session_key', 'model', 'display_name'],
  transcript_events: ['session_id', 'seq', 'event_json', 'created_at', 'event_zstd',
    'event_utf8_bytes', 'navigation_json'],
};

export function isOpenClawDatabasePath(filePath: string): boolean {
  return path.basename(filePath) === OPENCLAW_DATABASE_NAME;
}

export function openClawDatabasePathForChange(filePath: string): string | undefined {
  const mainPath = filePath.replace(/-(wal|shm)$/, '');
  return isOpenClawDatabasePath(mainPath) ? mainPath : undefined;
}

interface WindowRow {
  session_id: string;
  session_key: string;
  previous_session_id: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  status: string | null;
  parent_session_key: string | null;
  model: string | null;
  display_name: string | null;
  entry_json: string | null;
}

interface NodeRow {
  session_key: string;
  current_session_id: string;
  parent_session_key: string | null;
}

interface EventRow {
  seq: number;
  event_json: string | null;
  event_zstd: Buffer | null;
  event_utf8_bytes: number | null;
  created_at: number;
  navigation_json: string | null;
}

function validateSchema(db: Database.Database): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    const available = new Set(columns.map((column) => column.name));
    const missing = required.filter((column) => !available.has(column));
    if (missing.length > 0) {
      throw new Error(`Unsupported OpenClaw SQLite schema: ${table} missing [${missing.join(', ')}] (supported contract: v2026.11.3)`);
    }
  }
}

/** Reopen on retry and take one consistent read snapshot, without changing the external database. */
export async function withOpenClawSnapshot<T>(
  dbPath: string,
  read: (db: Database.Database) => T,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 300');
      const connection = db;
      return db.transaction(() => {
        validateSchema(connection);
        return read(connection);
      })();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (typeof code !== 'string' || !code.startsWith('SQLITE_BUSY') || attempt >= 2) throw error;
    } finally {
      db?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function listOpenClawSqliteSessions(dbPath: string): Promise<Array<{ id: string; updatedAt: number }>> {
  return withOpenClawSnapshot(dbPath, (db) => db.prepare(
    'SELECT session_id AS id, updated_at AS updatedAt FROM session_windows ORDER BY updated_at DESC, session_id',
  ).all() as Array<{ id: string; updatedAt: number }>);
}

/** Count unsupported archive owners without reading their potentially large/private blob payloads. */
export async function countOpenClawSqliteArchives(dbPath: string): Promise<number> {
  return withOpenClawSnapshot(dbPath, (db) => {
    let count = 0;
    for (const table of ['session_transcript_cold_archives', 'session_transcript_archives']) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        count += (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      }
    }
    return count;
  });
}

function decodeEvent(row: EventRow): string {
  if (row.event_json !== null) return row.event_json;
  const bytes = row.event_utf8_bytes;
  if (!row.event_zstd) throw new Error('Transcript body unavailable (cold archive or navigation-only row)');
  if (!Number.isSafeInteger(bytes) || bytes === null || bytes < 1 || bytes > MAX_EVENT_BYTES
    || row.event_zstd.length === 0 || row.event_zstd.length > MAX_EVENT_BYTES) {
    throw new Error('Invalid compressed transcript payload bounds');
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('Compressed OpenClaw transcript requires a Node runtime with zstd support (Node 22.15+ or 24+)');
  }
  const decoded = zlib.zstdDecompressSync(row.event_zstd, { maxOutputLength: bytes });
  if (decoded.byteLength !== bytes) throw new Error('Compressed transcript payload length mismatch');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function iso(value: number | null): string | undefined {
  if (value === null || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Exact selected payloads, not SQLite file mtime, own a session's cache identity. */
export async function parseOpenClawSqliteSession(
  dbPath: string,
  sessionId: string,
  project: string,
): Promise<{ result: ParseResult; fingerprint: string }> {
  const snapshot = await withOpenClawSnapshot(dbPath, (db) => {
    const window = db.prepare(`
      SELECT w.session_id, w.session_key, w.previous_session_id, w.reason, w.created_at,
        w.updated_at, w.started_at, w.ended_at, w.status, COALESCE(w.parent_session_key, n.parent_session_key) AS parent_session_key, w.model,
        w.display_name, CASE WHEN n.current_session_id = w.session_id THEN n.entry_json END AS entry_json
      FROM session_windows w LEFT JOIN session_nodes n ON n.session_key = w.session_key
      WHERE w.session_id = ?
    `).get(sessionId) as WindowRow | undefined;
    if (!window) throw new Error(`OpenClaw session window not found: ${sessionId}`);
    const nodes = db.prepare(`WITH RECURSIVE ancestors AS (
      SELECT session_key, current_session_id, parent_session_key FROM session_nodes WHERE session_key = ?
      UNION
      SELECT n.session_key, n.current_session_id, n.parent_session_key
      FROM session_nodes n JOIN ancestors a ON n.session_key = a.parent_session_key
    ) SELECT * FROM ancestors`).all(window.parent_session_key) as NodeRow[];
    const events = db.prepare(`SELECT seq, event_json, event_zstd, event_utf8_bytes, created_at, navigation_json
      FROM transcript_events WHERE session_id = ? ORDER BY seq ASC`).all(sessionId) as EventRow[];
    const coldTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_transcript_cold_archives'").get();
    const cold = Boolean(coldTable && db.prepare('SELECT 1 FROM session_transcript_cold_archives WHERE session_id = ?').get(sessionId));
    return { window, nodes, events, cold };
  });
  const { window, nodes, events, cold } = snapshot;
  const hash = createHash('sha256').update(JSON.stringify({ window, nodes, cold }));
  const lines: string[] = [];
  const parsedEvents: Array<Record<string, unknown> | undefined> = [];
  const unavailable: string[] = [];
  for (const row of events) {
    hash.update(JSON.stringify([row.seq, row.event_json, row.event_utf8_bytes, row.created_at, row.navigation_json]));
    if (row.event_zstd) hash.update(row.event_zstd);
    try {
      const line = decodeEvent(row);
      lines.push(line);
      try { parsedEvents.push(record(JSON.parse(line))); } catch { parsedEvents.push(undefined); }
    } catch (error) {
      // Never substitute navigation projections for missing private message bodies.
      unavailable.push(`seq ${row.seq}: ${error instanceof Error ? error.message : 'Unreadable transcript payload'}`);
    }
  }
  let entry: Record<string, unknown> | undefined;
  try {
    entry = window.entry_json ? record(JSON.parse(window.entry_json)) : undefined;
  } catch {
    unavailable.push('Session metadata entry_json is not valid JSON');
  }
  const header = parsedEvents.find((event) => event?.type === 'session');
  const cwd = text(header?.cwd) ?? text(entry?.spawnedCwd) ?? text(entry?.spawnedWorkspaceDir);
  const logicalPath = `${dbPath}#${sessionId}`;
  const agentName = path.basename(path.dirname(path.dirname(dbPath)));
  const result = await parseOpenClawRecords(lines, {
    sessionKey: window.session_key, uuid: sessionId, agentName,
    project: cwd ?? project, filePath: logicalPath, fileMtime: window.updated_at,
  });
  result.session.name = window.display_name ?? text(entry?.displayName) ?? text(entry?.label);
  result.session.cwd = cwd;
  result.session.sourceSessionId = sessionId;
  result.session.sourceVersion = 'openclaw-sqlite/v2026.11.3';
  result.session.agentName = agentName;
  result.session.startedAt = iso(window.started_at) ?? text(header?.timestamp) ?? result.session.startedAt ?? iso(window.created_at) ?? null;
  result.session.endedAt = window.status === 'running' ? null : iso(window.ended_at) ?? result.session.endedAt;
  result.session.status = window.status === 'running' ? 'active'
    : window.status === 'failed' ? 'error'
      : window.status === 'killed' || window.status === 'timeout' ? 'aborted' : 'idle';
  result.session.metrics.terminationStatus = window.status ?? undefined;
  const nodesByKey = new Map(nodes.map((node) => [node.session_key, node]));
  const parentKey = window.parent_session_key;
  const parent = parentKey ? nodesByKey.get(parentKey) : undefined;
  if (parent) {
    result.session.parentSessionId = parent.current_session_id;
    result.session.rootSessionId = parent.current_session_id;
    result.session.relationshipType = 'subagent';
    const visited = new Set([window.session_key]);
    let ancestor: NodeRow | undefined = parent;
    while (ancestor && !visited.has(ancestor.session_key)) {
      visited.add(ancestor.session_key);
      result.session.rootSessionId = ancestor.current_session_id;
      ancestor = ancestor.parent_session_key ? nodesByKey.get(ancestor.parent_session_key) : undefined;
    }
  } else if (window.reason === 'fork' && window.previous_session_id) {
    result.session.parentSessionId = window.previous_session_id;
    result.session.rootSessionId = window.previous_session_id;
    result.session.relationshipType = 'fork';
  } else {
    result.session.relationshipType = 'root';
  }
  enrichToolResults(result, parsedEvents, window.model);
  for (const message of result.messages) {
    message.sourceMetadata.sourceVersion = result.session.sourceVersion;
    message.sourceMetadata.cwd = cwd;
  }
  if (cold || unavailable.length > 0 || result.errors.length > 0) {
    result.session.metrics.isTruncated = true;
    result.warnings.push('Partial OpenClaw transcript: cold, unavailable, or malformed event bodies were not reconstructed.');
    result.warnings.push(...unavailable);
    if (cold) result.warnings.push('Cold transcript archive is not decoded by this adapter.');
  }
  return { result, fingerprint: hash.digest('hex') };
}

/** The shared mapper keeps legacy output stable; SQLite events provide explicit tool/result identities. */
function enrichToolResults(result: ParseResult, events: Array<Record<string, unknown> | undefined>, model: string | null): void {
  const tools = new Map<string, TraceToolCall>();
  const messagesByLine = new Map(result.messages.map((message) => [message.sourceMetadata.sourceLine, message]));
  const activitiesById = new Map(result.activities.flatMap((item) => item.type === 'tool_call' ? [[item.id, item] as const] : []));
  for (const [index, event] of events.entries()) {
    const message = record(event?.message);
    if (event?.type !== 'message' || !message) continue;
    const traceMessage = messagesByLine.get(index + 1);
    if (!traceMessage) continue;
    traceMessage.model ??= model ?? undefined;
    if (traceMessage.role === 'assistant' && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = record(value);
        const id = text(block?.id);
        if (!block || !id || (block.type !== 'toolCall' && block.type !== 'tool_use')) continue;
        const tool = activitiesById.get(id);
        if (tool) {
          tool.messageOrdinal = traceMessage.ordinal;
          tool.sourceLine = index + 1;
          tools.set(id, tool);
        }
      }
    }
    if (traceMessage.role === 'tool_result') {
      const tool = tools.get(text(message.toolCallId) ?? text(message.tool_use_id) ?? '');
      if (tool) {
        tool.resultEvents.push({ type: 'result_event', content: traceMessage.content,
          timestamp: traceMessage.timestamp, isPartial: false });
        tool.status = message.isError === true || message.is_error === true ? 'error' : 'success';
        if (tool.status === 'error') tool.error = traceMessage.content;
      }
    }
  }
}
