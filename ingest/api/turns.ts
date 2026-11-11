/**
 * Turns & Messages API Routes
 *
 * REST API endpoints for turn-first retrieval and message listing.
 * Provides turn grouping via assembler and raw message access with role filtering.
 *
 * @module ingest/api/turns
 */

import { Hono } from 'hono';
import { getDatabase } from '../db';
import { assembleTurns, getTurnCount } from '../turns/assembler';

export const turnsRoutes = new Hono();

// ============================================================================
// GET /api/v1/sessions/:id/turns - Get turns for a session
// ============================================================================

turnsRoutes.get('/api/v1/sessions/:id/turns', async (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');

  // Validate session ID format to prevent path traversal
  if (!/^[a-zA-Z0-9:\-_.]{1,256}$/.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format', sessionId }, 400);
  }

  // Verify session exists
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    return c.json({
      error: 'Session not found',
      sessionId
    }, 404);
  }

  // Parse and validate limit/offset (T-02-14: reject negative values)
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  if (isNaN(limit) || limit < 0) {
    return c.json({ error: 'Invalid limit parameter, must be non-negative integer' }, 400);
  }
  if (isNaN(offset) || offset < 0) {
    return c.json({ error: 'Invalid offset parameter, must be non-negative integer' }, 400);
  }

  // Cap limit to prevent resource exhaustion (T-02-14)
  const cappedLimit = Math.min(limit, 1000);

  // Get turn count
  const totalTurns = getTurnCount(sessionId, db);

  // Assemble turns
  const allTurns = await assembleTurns(sessionId, db);

  // Apply pagination
  const paginatedTurns = allTurns.slice(offset, offset + cappedLimit);

  return c.json({
    sessionId,
    turns: paginatedTurns,
    pagination: {
      total: totalTurns,
      limit: cappedLimit,
      offset,
      hasMore: offset + cappedLimit < totalTurns
    }
  });
});

// ============================================================================
// GET /api/v1/sessions/:id/turns/:index - Get specific turn
// ============================================================================

turnsRoutes.get('/api/v1/sessions/:id/turns/:index', async (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');
  const turnIndex = parseInt(c.req.param('index'), 10);

  // Validate session ID format to prevent path traversal
  if (!/^[a-zA-Z0-9:\-_.]{1,256}$/.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format', sessionId }, 400);
  }

  // Validate turn index (must be a non-negative integer)
  if (isNaN(turnIndex) || turnIndex < 0) {
    return c.json({
      error: 'Invalid turn index, must be a non-negative integer',
      turnIndex: c.req.param('index')
    }, 400);
  }

  // Verify session exists
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    return c.json({
      error: 'Session not found',
      sessionId
    }, 404);
  }

  // Assemble turns and find by index
  const turns = await assembleTurns(sessionId, db);
  const turn = turns.find(t => t.index === turnIndex);

  if (!turn) {
    return c.json({
      error: 'Turn not found',
      sessionId,
      turnIndex
    }, 404);
  }

  return c.json(turn);
});

// ============================================================================
// GET /api/v1/sessions/:id/messages - Get messages for a session
// ============================================================================

turnsRoutes.get('/api/v1/sessions/:id/messages', (c) => {
  const db = getDatabase();
  const sessionId = c.req.param('id');

  // Validate session ID format to prevent path traversal
  if (!/^[a-zA-Z0-9:\-_.]{1,256}$/.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format', sessionId }, 400);
  }

  // Verify session exists
  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!session) {
    return c.json({
      error: 'Session not found',
      sessionId
    }, 404);
  }

  // Parse and validate limit/offset (T-02-14: reject negative values)
  const limit = parseInt(c.req.query('limit') || '100', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  if (isNaN(limit) || limit < 0) {
    return c.json({ error: 'Invalid limit parameter, must be non-negative integer' }, 400);
  }
  if (isNaN(offset) || offset < 0) {
    return c.json({ error: 'Invalid offset parameter, must be non-negative integer' }, 400);
  }

  // Cap limit to prevent resource exhaustion (T-02-14)
  const cappedLimit = Math.min(limit, 1000);

  // Parse and validate role filter (T-02-15: whitelist allowed roles)
  const role = c.req.query('role') || null;
  if (role && !['user', 'assistant', 'system', 'tool_result'].includes(role)) {
    return c.json({
      error: 'Invalid role filter. Must be one of: user, assistant, system, tool_result'
    }, 400);
  }

  // Build query
  let query = `
    SELECT
      id, ordinal, role, content, timestamp, model,
      token_usage_json, source_file, source_line
    FROM messages
    WHERE session_id = ?
  `;
  const params: unknown[] = [sessionId];

  if (role) {
    query += ' AND role = ?';
    params.push(role);
  }

  query += ' ORDER BY ordinal ASC LIMIT ? OFFSET ?';
  params.push(cappedLimit, offset);

  // Get total count
  let countQuery = 'SELECT COUNT(*) as total FROM messages WHERE session_id = ?';
  const countParams: unknown[] = [sessionId];
  if (role) {
    countQuery += ' AND role = ?';
    countParams.push(role);
  }
  const countResult = db.prepare(countQuery).get(...countParams) as { total: number };

  // Get messages
  const messages = db.prepare(query).all(...params) as MessageRow[];

  return c.json({
    sessionId,
    messages: messages.map(parseMessageRow),
    pagination: {
      total: countResult.total,
      limit: cappedLimit,
      offset,
      hasMore: offset + cappedLimit < countResult.total
    }
  });
});

// ============================================================================
// Types
// ============================================================================

interface MessageRow {
  id: string;
  ordinal: number;
  role: string;
  content: string;
  timestamp: string | null;
  model: string | null;
  token_usage_json: string | null;
  source_file: string;
  source_line: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

function parseMessageRow(row: MessageRow) {
  return {
    id: row.id,
    ordinal: row.ordinal,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
    model: row.model,
    tokenUsage: row.token_usage_json ? JSON.parse(row.token_usage_json) : null,
    sourceMetadata: {
      sourceType: 'openclaw', // TODO: Get from session join in Phase 3
      sourceFile: row.source_file,
      sourceLine: row.source_line
    }
  };
}
