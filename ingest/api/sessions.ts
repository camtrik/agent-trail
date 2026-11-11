/**
 * Sessions API Routes
 *
 * REST API endpoints for session listing and detail retrieval.
 * Provides filtering by source, project, status with pagination and sorting.
 *
 * @module ingest/api/sessions
 */

import { Hono } from 'hono';
import { getDatabase } from '../db';
import { TraceSession, SessionStatus, TraceSource } from '@/types/trace';
import { estimateSessionCost } from '../pricing/session-pricing.js';
import { getDisplayModelName } from '../pricing/normalize-model.js';

export const sessionsRoutes = new Hono();

const VALID_SOURCES = ['openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder'] as const;
const VALID_SESSION_SORTS = [
  'updated_at',
  'started_at',
  'ended_at',
  'title',
  'project',
  'turns',
  'tokens',
  'cost',
  'activity',
] as const;

const UPDATED_AT_EXPR = updatedAtExpr();

function column(alias: string | undefined, name: string): string {
  return alias ? `${alias}.${name}` : name;
}

export function updatedAtExpr(alias?: string): string {
  const source = column(alias, 'source');
  return `CASE WHEN ${source} = 'qoder'
    THEN MAX(COALESCE(${column(alias, 'ended_at')}, ''), COALESCE(${column(alias, 'started_at')}, ''))
    ELSE MAX(COALESCE(${column(alias, 'ended_at')}, ''), COALESCE(${column(alias, 'started_at')}, ''), COALESCE(${column(alias, 'file_mtime')}, ''))
  END`;
}

export function sessionDisplayTitleExpr(alias?: string): string {
  return `COALESCE(${column(alias, 'name')}, ${column(alias, 'project')} || ' — ' || COALESCE(substr(${column(alias, 'started_at')}, 1, 10), 'unknown'))`;
}

function sessionTotalTokensExpr(alias?: string): string {
  const channelTotal = `COALESCE(${column(alias, 'total_input_tokens')}, 0) + COALESCE(${column(alias, 'total_output_tokens')}, 0) + COALESCE(${column(alias, 'total_cache_read_tokens')}, 0) + COALESCE(${column(alias, 'total_cache_write_tokens')}, 0) + COALESCE(${column(alias, 'total_reasoning_tokens')}, 0)`;
  return `CASE WHEN ${column(alias, 'source')} = 'opencode' THEN ${channelTotal} WHEN COALESCE(${column(alias, 'total_tokens')}, 0) > 0 THEN ${column(alias, 'total_tokens')} ELSE ${channelTotal} END`;
}

function isValidSource(source: string): source is typeof VALID_SOURCES[number] {
  return (VALID_SOURCES as readonly string[]).includes(source);
}

function isValidSessionSort(sort: string): sort is typeof VALID_SESSION_SORTS[number] {
  return (VALID_SESSION_SORTS as readonly string[]).includes(sort);
}

interface SessionDisplayTitleParts {
  displayTitle?: string | null;
  name?: string | null;
  project: string;
  startedAt?: string | null;
  updatedAt?: string | null;
}

export function resolveSessionDisplayTitle({
  displayTitle,
  name,
  project,
  startedAt,
  updatedAt,
}: SessionDisplayTitleParts): string {
  return displayTitle || name || `${project} — ${(startedAt ?? updatedAt)?.split('T')[0] || 'unknown'}`;
}

// ============================================================================
// GET /api/v1/sessions/lookup - Look up session by external key
// (must be BEFORE the /:id wildcard route so Hono matches it first)
// ============================================================================

sessionsRoutes.get('/api/v1/sessions/lookup', (c) => {
  const source = c.req.query('source') as string;
  const key = c.req.query('key') as string;

  // Validate required params BEFORE accessing the database
  if (!source || !key) {
    return c.json({
      error: 'source and key query parameters are required'
    }, 400);
  }

  // Validate source (whitelisted values only)
  if (!['openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder'].includes(source)) {
    return c.json({
      error: 'Invalid source parameter'
    }, 400);
  }

  // Validate key format (prevent injection, path traversal)
  if (!/^[a-zA-Z0-9:\-_.]{1,256}$/.test(key)) {
    return c.json({
      error: 'Invalid key format'
    }, 400);
  }

  const db = getDatabase();

  // Attempt lookup: first try exact ID match, then try source_session_id
  const session = db.prepare(`
    SELECT
      id, source, project, name, started_at, ended_at, status,
      root_session_id, parent_session_id, relationship_type, source_session_id,
      message_count, user_message_count, total_output_tokens, total_input_tokens,
      total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens, total_tokens,
      has_tool_calls, parser_malformed_lines, is_truncated, termination_status,
      last_sync_at, file_mtime, cwd, git_branch, agent_name,
      source_cost_usd, cost_source, cost_pricing_status,
      ${UPDATED_AT_EXPR} as updated_at
    FROM sessions
    WHERE source = ? AND (id = ? OR source_session_id = ?)
    LIMIT 1
  `).get(source, key, key) as SessionRow | undefined;

  if (!session) {
    return c.json({
      error: 'Session not found for key',
      source,
      key
    }, 404);
  }

  return c.json(parseSessionRow(session));
});

// ============================================================================
// GET /api/v1/sessions - List sessions
// ============================================================================

sessionsRoutes.get('/api/v1/sessions', (c) => {
  // Parse query parameters
  const source = c.req.query('source') as TraceSource | null;
  const project = c.req.query('project') || null;
  const status = c.req.query('status') as SessionStatus | 'truncated' | null;
  const q = (c.req.query('q') || c.req.query('search') || '').trim();
  const starred = c.req.query('starred') === 'true';
  const sort = c.req.query('sort') || 'updated_at';
  const order = c.req.query('order') || 'desc'; // asc or desc
  const includeChildren = c.req.query('includeChildren') === 'true';

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

  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  if (status && !['active', 'idle', 'aborted', 'error', 'unknown', 'truncated'].includes(status)) {
    return c.json({ error: 'Invalid status parameter' }, 400);
  }

  // Validate sort parameter (only allow safe column names/aliases)
  if (!isValidSessionSort(sort)) {
    return c.json({ error: 'Invalid sort parameter. Must be one of: updated_at, started_at, ended_at, title, project, turns, tokens, cost, activity' }, 400);
  }

  // Validate order parameter
  if (order !== 'asc' && order !== 'desc') {
    return c.json({ error: 'Invalid order parameter. Must be "asc" or "desc"' }, 400);
  }

  // Parse and validate groupBy (allow agent, project, or both)
  const groupByRaw = c.req.query('groupBy');
  const validGroupByValues = ['agent', 'project'];
  let groupByDimensions: string[] = [];
  if (groupByRaw) {
    const requested = groupByRaw.split(',').map(d => d.trim()).filter(Boolean);
    if (requested.length === 0 || requested.some(d => !validGroupByValues.includes(d))) {
      return c.json({ error: 'Invalid groupBy parameter. Must be "agent", "project", or comma-separated combination' }, 400);
    }
    groupByDimensions = [...new Set(requested)];
  }

  const db = getDatabase();

  // Build query conditions
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (source) {
    conditions.push('s.source = ?');
    params.push(source);
  }

  if (project) {
    conditions.push('s.project = ?');
    params.push(project);
  }

  if (status) {
    if (status === 'truncated') {
      conditions.push('s.is_truncated = 1');
    } else {
      conditions.push('s.status = ?');
      params.push(status);
    }
  }

  if (starred) {
    conditions.push('EXISTS (SELECT 1 FROM session_stars ss WHERE ss.session_id = s.id)');
  }

  if (q) {
    const like = `%${q.toLowerCase()}%`;
    conditions.push(`(
      LOWER(COALESCE(s.name, '')) LIKE ?
      OR LOWER(s.project) LIKE ?
      OR LOWER(s.id) LIKE ?
    )`);
    params.push(like, like, like);
  }

  if (!includeChildren) {
    conditions.push('(s.relationship_type IS NULL OR s.relationship_type = ?)');
    params.push('root');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countResult = db.prepare(`
    SELECT COUNT(*) as total
    FROM sessions s
    ${whereClause}
  `).get(...params) as { total: number };

  // Get sessions
  const orderBy =
    sort === 'updated_at' ? 'updated_at'
      : sort === 'ended_at' ? 'ended_at'
        : sort === 'started_at' ? 'started_at'
          : sort === 'title' ? 'display_title'
            : sort === 'project' ? 'project'
              : sort === 'turns' ? 'user_message_count'
                : sort === 'activity' ? 'activity_count'
                  : sort === 'cost' ? 'source_cost_usd'
                    : 'computed_total_tokens';
  const orderDir = order === 'asc' ? 'ASC' : 'DESC';

  const sessions = db.prepare(`
    SELECT
      s.id, s.source, s.project, s.name, s.started_at, s.ended_at, s.status,
      s.root_session_id, s.parent_session_id, s.relationship_type, s.source_session_id,
      s.message_count, s.user_message_count, s.total_output_tokens, s.total_input_tokens,
      s.total_cache_read_tokens, s.total_cache_write_tokens, s.total_reasoning_tokens, s.total_tokens,
      s.has_tool_calls, s.parser_malformed_lines, s.is_truncated, s.termination_status,
      s.last_sync_at, s.file_mtime, s.cwd, s.git_branch, s.agent_name,
      s.source_cost_usd, s.cost_source, s.cost_pricing_status,
      ${updatedAtExpr('s')} as updated_at,
      ${sessionDisplayTitleExpr('s')} as display_title,
      ${sessionTotalTokensExpr('s')} as computed_total_tokens,
      (
        SELECT m.model
        FROM messages m
        WHERE m.session_id = s.id
          AND TRIM(COALESCE(m.model, '')) <> ''
          AND m.model <> '<synthetic>'
        ORDER BY m.ordinal DESC
        LIMIT 1
      ) as model,
      (
        SELECT m.content
        FROM messages m
        WHERE m.session_id = s.id
          AND m.role = 'user'
          AND TRIM(COALESCE(m.content, '')) <> ''
        ORDER BY m.ordinal ASC
        LIMIT 1
      ) as summary,
      (
        SELECT COUNT(*)
        FROM tool_calls tc
        WHERE tc.session_id = s.id
      ) as tool_call_count,
      (
        SELECT COUNT(*)
        FROM subagent_links sl
        WHERE sl.session_id = s.id
      ) as subagent_count,
      (
        (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id = s.id)
        + (SELECT COUNT(*) FROM subagent_links sl WHERE sl.session_id = s.id)
      ) as activity_count
    FROM sessions s
    ${whereClause}
    ORDER BY ${orderBy} ${orderDir} NULLS LAST, updated_at DESC, id ASC
    LIMIT ? OFFSET ?
  `).all(...params, cappedLimit, offset) as SessionRow[];

  const groupCounts: { agent?: Array<{ label: string; count: number }>; project?: Array<{ label: string; count: number }> } = {};

  if (groupByDimensions.includes('agent')) {
    const agentRows = db.prepare(`
      SELECT COALESCE(agent_name, source) as label, COUNT(*) as count
      FROM sessions s
      ${whereClause}
      GROUP BY label
      ORDER BY count DESC
    `).all(...params) as Array<{ label: string; count: number }>;
    groupCounts.agent = agentRows;
  }

  if (groupByDimensions.includes('project')) {
    const projectRows = db.prepare(`
      SELECT COALESCE(NULLIF(project, 'default'), '-') as label, COUNT(*) as count
      FROM sessions s
      ${whereClause}
      GROUP BY label
      ORDER BY count DESC
    `).all(...params) as Array<{ label: string; count: number }>;
    groupCounts.project = projectRows;
  }

  const responseBody: {
    sessions: ReturnType<typeof parseSessionRow>[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
    groupCounts?: { agent?: Array<{ label: string; count: number }>; project?: Array<{ label: string; count: number }> };
  } = {
    sessions: sessions.map(row => parseSessionRow(row)),
    pagination: {
      total: countResult.total,
      limit: cappedLimit,
      offset,
      hasMore: offset + cappedLimit < countResult.total
    }
  };

  if (Object.keys(groupCounts).length > 0) {
    responseBody.groupCounts = groupCounts;
  }

  return c.json(responseBody);
});

// ============================================================================
// GET /api/v1/sessions/:id - Get session by ID
// ============================================================================

sessionsRoutes.get('/api/v1/sessions/:id', (c) => {
  const sessionId = c.req.param('id');

  // Validate session ID format BEFORE DB access (T-02-13: prevent injection via format check)
  if (!/^[a-zA-Z0-9:\-_.]{1,256}$/.test(sessionId)) {
    return c.json({ error: 'Invalid session ID format', sessionId }, 400);
  }

  const db = getDatabase();

  const session = db.prepare(`
    SELECT
      s.id, s.source, s.project, s.name, s.started_at, s.ended_at, s.status,
      s.root_session_id, s.parent_session_id, s.relationship_type, s.source_session_id,
      s.message_count, s.user_message_count, s.total_output_tokens, s.total_input_tokens,
      s.total_cache_read_tokens, s.total_cache_write_tokens, s.total_reasoning_tokens, s.total_tokens,
      s.has_tool_calls, s.parser_malformed_lines, s.is_truncated, s.termination_status,
      s.last_sync_at, s.file_mtime, s.cwd, s.git_branch, s.agent_name,
      s.source_cost_usd, s.cost_source, s.cost_pricing_status,
      ${updatedAtExpr('s')} as updated_at,
      ${sessionDisplayTitleExpr('s')} as display_title,
      ${sessionTotalTokensExpr('s')} as computed_total_tokens,
      (
        SELECT m.model
        FROM messages m
        WHERE m.session_id = s.id
          AND TRIM(COALESCE(m.model, '')) <> ''
          AND m.model <> '<synthetic>'
        ORDER BY m.ordinal DESC
        LIMIT 1
      ) as model,
      (
        SELECT m.content
        FROM messages m
        WHERE m.session_id = s.id
          AND m.role = 'user'
          AND TRIM(COALESCE(m.content, '')) <> ''
        ORDER BY m.ordinal ASC
        LIMIT 1
      ) as summary,
      (
        SELECT COUNT(*)
        FROM tool_calls tc
        WHERE tc.session_id = s.id
      ) as tool_call_count,
      (
        SELECT COUNT(*)
        FROM subagent_links sl
        WHERE sl.session_id = s.id
      ) as subagent_count
    FROM sessions s
    WHERE s.id = ?
  `).get(sessionId) as SessionRow | undefined;

  if (!session) {
    return c.json({
      error: 'Session not found',
      sessionId
    }, 404);
  }

  return c.json(parseSessionRow(session));
});

// ============================================================================
// Types
// ============================================================================

interface SessionRow {
  id: string;
  source: string;
  project: string;
  name: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  root_session_id: string | null;
  parent_session_id: string | null;
  relationship_type: string | null;
  source_session_id: string | null;
  message_count: number;
  user_message_count: number;
  total_output_tokens: number;
  total_input_tokens: number;
  total_cache_read_tokens?: number;
  total_cache_write_tokens?: number;
  total_reasoning_tokens?: number;
  total_tokens?: number;
  has_tool_calls: number;
  parser_malformed_lines: number;
  is_truncated: number;
  termination_status: string | null;
  last_sync_at: string | null;
  file_mtime: string | null;
  updated_at: string | null;
  cwd: string | null;
  git_branch: string | null;
  agent_name: string | null;
  display_title?: string | null;
  computed_total_tokens?: number;
  model?: string | null;
  summary?: string | null;
  tool_call_count?: number;
  subagent_count?: number;
  source_cost_usd?: number | null;
  cost_source?: string | null;
  cost_pricing_status?: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

function parseSessionRow(row: SessionRow): TraceSession {
  const inputTokens = row.total_input_tokens || 0;
  const outputTokens = row.total_output_tokens || 0;
  const cacheReadTokens = row.total_cache_read_tokens || 0;
  const cacheWriteTokens = row.total_cache_write_tokens || 0;
  const reasoningTokens = row.total_reasoning_tokens || 0;
  const channelTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
  const totalTokens = row.source === 'opencode'
    ? channelTotal
    : row.total_tokens || row.computed_total_tokens || channelTotal;

  const costEstimate = estimateSessionCost(getDatabase(), row.id);
  const estimatedCost = costEstimate.cost;
  const pricingStatus = costEstimate.pricingStatus;

  const summary = normalizeSummary(row.summary);
  const toolCalls = row.tool_call_count || 0;
  const subagents = row.subagent_count || 0;

  return {
    id: row.id,
    source: row.source as TraceSource,
    project: row.project,
    name: row.name || undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at || undefined,
    lastSyncAt: row.last_sync_at || undefined,
    status: row.status as SessionStatus,
    rootSessionId: row.root_session_id || undefined,
    parentSessionId: row.parent_session_id || undefined,
    relationshipType: (row.relationship_type as TraceSession['relationshipType']) || undefined,
    sourceSessionId: row.source_session_id || undefined,
    cwd: row.cwd || undefined,
    gitBranch: row.git_branch || undefined,
    agentName: row.agent_name || undefined,
    model: getDisplayModelName(row.model) || undefined,
    summary: summary || undefined,
    metrics: {
      messageCount: row.message_count,
      userMessageCount: row.user_message_count,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens,
      hasToolCalls: row.has_tool_calls === 1,
      terminationStatus: row.termination_status || undefined,
      parserMalformedLines: row.parser_malformed_lines,
      isTruncated: row.is_truncated === 1
    },
    turns: [], // Turns loaded separately via /sessions/:id/turns
    activityCounts: {
      toolCalls,
      skills: 0,
      subagents,
      thinking: 0,
      system: row.parser_malformed_lines > 0 || row.is_truncated === 1 ? 1 : 0,
    },
    // Phase 10 enrichment fields
    displayTitle: resolveSessionDisplayTitle({
      displayTitle: row.display_title,
      name: row.name,
      project: row.project,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }),
    durationMs: row.started_at && row.ended_at
      ? new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()
      : null,
    totalTurns: row.user_message_count,
    inputTokens,
    outputTokens,
    estimatedCost: estimatedCost,
    sourceCostUsd: row.source_cost_usd ?? undefined,
    costSource: row.source_cost_usd != null ? (row.cost_source ?? undefined) : 'model-pricing-estimate',
    costPricingStatus: pricingStatus,
  };
}

export function normalizeSummary(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}
