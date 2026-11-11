/**
 * Search Routes
 *
 * Provides both global session-content search and in-session message search.
 * Both endpoints prefer SQLite FTS5 and fall back to LIKE queries when needed.
 *
 * @module ingest/api/search
 */

import { Hono } from 'hono';
import { getDatabase } from '../db';
import {
  normalizeSummary,
  resolveSessionDisplayTitle,
  sessionDisplayTitleExpr,
  updatedAtExpr,
} from './sessions.js';
import { parseSessionSearchLimit } from '@/lib/session-search';
import type {
  TraceSessionSearchHit,
  TraceSessionSearchResult,
  TraceSource,
} from '@/types/trace';

export const searchRoutes = new Hono();

const SESSION_ID_RE = /^[a-zA-Z0-9:\-_.]{1,256}$/;
const VALID_SOURCES = ['openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder'] as const;

interface MessageSearchRow {
  id: string;
  ordinal: number;
  role: string;
  turn_index: number | null;
  content: string | null;
  snippet?: string | null;
}

interface GlobalSearchRow {
  id: string;
  source: string;
  source_session_id: string | null;
  project: string;
  name: string | null;
  updated_at: string | null;
  display_title: string | null;
  summary: string | null;
  snippet?: string | null;
  content?: string | null;
  match_count: number;
}

function isValidSource(source: string): source is TraceSource {
  return (VALID_SOURCES as readonly string[]).includes(source);
}

function sanitizeSearchQuery(query: string): string {
  return query.replace(/["'*+\-():!^&|]/g, '').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFallbackSnippet(content: string | null | undefined, query: string): string {
  const compact = (content || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';

  const firstTerm = query.split(/\s+/).find(Boolean)?.toLowerCase() || '';
  const haystack = compact.toLowerCase();
  const matchIndex = firstTerm ? haystack.indexOf(firstTerm) : -1;
  const start = matchIndex >= 0 ? Math.max(0, matchIndex - 48) : 0;
  const end = matchIndex >= 0 ? Math.min(compact.length, matchIndex + firstTerm.length + 96) : Math.min(compact.length, 180);

  let snippet = compact.slice(start, end);
  if (start > 0) snippet = `...${snippet}`;
  if (end < compact.length) snippet = `${snippet}...`;

  if (firstTerm) {
    snippet = snippet.replace(
      new RegExp(escapeRegExp(firstTerm), 'i'),
      (match) => `>>>${match}<<<`,
    );
  }

  return snippet;
}

function buildSearchResponse(
  query: string,
  rows: GlobalSearchRow[],
  limit: number,
  snippetQuery: string,
): TraceSessionSearchResult {
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;

  const results: TraceSessionSearchHit[] = visibleRows.map((row) => {
    const displayTitle = resolveSessionDisplayTitle({
      displayTitle: row.display_title,
      name: row.name,
      project: row.project,
      updatedAt: row.updated_at,
    });

    return {
      id: row.id,
      sessionId: row.id,
      source: row.source as TraceSource,
      sourceSessionId: row.source_session_id || undefined,
      project: row.project,
      name: row.name || undefined,
      displayTitle,
      updatedAt: row.updated_at || undefined,
      summary: normalizeSummary(row.summary) || undefined,
      snippet: (row.snippet || buildFallbackSnippet(row.content, snippetQuery) || displayTitle).trim(),
      matchCount: row.match_count,
    };
  });

  return {
    query,
    results,
    pagination: {
      limit,
      returned: results.length,
      hasMore,
    },
  };
}

function buildSessionFilters(source: string | null, includeChildren: boolean): {
  clause: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (source) {
    conditions.push('s.source = ?');
    params.push(source);
  }

  if (!includeChildren) {
    conditions.push('(s.relationship_type IS NULL OR s.relationship_type = ?)');
    params.push('root');
  }

  return {
    clause: conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '',
    params,
  };
}

function searchSessionsWithFts(
  sanitizedQuery: string,
  source: string | null,
  includeChildren: boolean,
  limit: number,
): GlobalSearchRow[] {
  const db = getDatabase();
  const filters = buildSessionFilters(source, includeChildren);

  return db.prepare(`
    WITH matched_messages AS (
      SELECT
        s.id as session_id,
        m.id as message_id,
        m.ordinal,
        snippet(fts_messages_content, -1, '>>>', '<<<', '...', 24) as snippet,
        bm25(fts_messages_content) as score
      FROM fts_messages_content
      JOIN messages m ON m.rowid = fts_messages_content.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE fts_messages_content MATCH ?${filters.clause}
    ),
    ranked_matches AS (
      SELECT
        session_id,
        message_id,
        ordinal,
        snippet,
        score,
        COUNT(*) OVER (PARTITION BY session_id) as match_count,
        ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY score ASC, ordinal DESC
        ) as rank
      FROM matched_messages
    )
    SELECT
      s.id,
      s.source,
      s.source_session_id,
      s.project,
      s.name,
      ${updatedAtExpr('s')} as updated_at,
      ${sessionDisplayTitleExpr('s')} as display_title,
      (
        SELECT m.content
        FROM messages m
        WHERE m.session_id = s.id
          AND m.role = 'user'
          AND TRIM(COALESCE(m.content, '')) <> ''
        ORDER BY m.ordinal ASC
        LIMIT 1
      ) as summary,
      ranked_matches.snippet,
      ranked_matches.match_count
    FROM ranked_matches
    JOIN sessions s ON s.id = ranked_matches.session_id
    WHERE ranked_matches.rank = 1
    ORDER BY updated_at DESC NULLS LAST, ranked_matches.match_count DESC, s.id ASC
    LIMIT ?
  `).all(sanitizedQuery, ...filters.params, limit + 1) as GlobalSearchRow[];
}

function searchSessionsWithLike(
  sanitizedQuery: string,
  source: string | null,
  includeChildren: boolean,
  limit: number,
): GlobalSearchRow[] {
  const db = getDatabase();
  const filters = buildSessionFilters(source, includeChildren);

  return db.prepare(`
    WITH matched_messages AS (
      SELECT
        s.id as session_id,
        m.id as message_id,
        m.ordinal,
        m.content,
        COUNT(*) OVER (PARTITION BY s.id) as match_count,
        ROW_NUMBER() OVER (
          PARTITION BY s.id
          ORDER BY m.ordinal DESC
        ) as rank
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE LOWER(m.content) LIKE ?${filters.clause}
    )
    SELECT
      s.id,
      s.source,
      s.source_session_id,
      s.project,
      s.name,
      ${updatedAtExpr('s')} as updated_at,
      ${sessionDisplayTitleExpr('s')} as display_title,
      (
        SELECT m.content
        FROM messages m
        WHERE m.session_id = s.id
          AND m.role = 'user'
          AND TRIM(COALESCE(m.content, '')) <> ''
        ORDER BY m.ordinal ASC
        LIMIT 1
      ) as summary,
      matched_messages.content,
      matched_messages.match_count
    FROM matched_messages
    JOIN sessions s ON s.id = matched_messages.session_id
    WHERE matched_messages.rank = 1
    ORDER BY updated_at DESC NULLS LAST, matched_messages.match_count DESC, s.id ASC
    LIMIT ?
  `).all(`%${sanitizedQuery.toLowerCase()}%`, ...filters.params, limit + 1) as GlobalSearchRow[];
}

// ============================================================================
// GET /api/v1/sessions/search?q=query
// ============================================================================

searchRoutes.get('/api/v1/sessions/search', (c) => {
  const query = c.req.query('q');
  const source = c.req.query('source');
  const includeChildren = c.req.query('includeChildren') === 'true';
  const limit = parseSessionSearchLimit(c.req.query('limit'));

  if (!query || query.trim().length === 0) {
    return c.json({ error: 'Search query (q) is required' }, 400);
  }

  if (limit === null) {
    return c.json({ error: 'Invalid limit parameter, must be non-negative integer' }, 400);
  }

  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  const sanitizedQuery = sanitizeSearchQuery(query);
  if (sanitizedQuery.length === 0) {
    return c.json({ error: 'Search query is empty after sanitization' }, 400);
  }

  try {
    const rows = searchSessionsWithFts(sanitizedQuery, source || null, includeChildren, limit);
    return c.json(buildSearchResponse(query, rows, limit, sanitizedQuery));
  } catch {
    const rows = searchSessionsWithLike(sanitizedQuery, source || null, includeChildren, limit);
    return c.json(buildSearchResponse(query, rows, limit, sanitizedQuery));
  }
});

// ============================================================================
// GET /api/v1/sessions/:id/search?q=query
// ============================================================================

searchRoutes.get('/api/v1/sessions/:id/search', (c) => {
  const sessionId = c.req.param('id');
  const query = c.req.query('q');

  // Validate session ID format (T-10-09: prevent path traversal)
  if (!SESSION_ID_RE.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format' }, 400);
  }

  if (!query || query.trim().length === 0) {
    return c.json({ error: 'Search query (q) is required' }, 400);
  }

  const db = getDatabase();
  const sanitizedQuery = sanitizeSearchQuery(query);

  if (sanitizedQuery.length === 0) {
    return c.json({ error: 'Search query is empty after sanitization' }, 400);
  }

  try {
    const results = db.prepare(`
      SELECT m.id, m.ordinal, m.role, m.turn_index, m.content,
             snippet(fts_messages_content, -1, '>>>', '<<<', '...', 32) as snippet
      FROM fts_messages_content
      JOIN messages m ON m.rowid = fts_messages_content.rowid
      WHERE fts_messages_content MATCH ? AND m.session_id = ?
      ORDER BY m.ordinal ASC
    `).all(sanitizedQuery, sessionId) as MessageSearchRow[];

    return c.json({
      sessionId,
      query,
      results: results.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        role: r.role,
        turnIndex: r.turn_index,
        snippet: r.snippet || buildFallbackSnippet(r.content, sanitizedQuery),
      })),
    });
  } catch {
    const likeResults = db.prepare(`
      SELECT id, ordinal, role, turn_index, content
      FROM messages
      WHERE session_id = ? AND content LIKE ?
      ORDER BY ordinal ASC
    `).all(sessionId, `%${sanitizedQuery}%`) as MessageSearchRow[];

    return c.json({
      sessionId,
      query,
      results: likeResults.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        role: r.role,
        turnIndex: r.turn_index,
        snippet: buildFallbackSnippet(r.content, sanitizedQuery),
      })),
    });
  }
});
