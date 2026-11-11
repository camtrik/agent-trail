/**
 * Overview API Routes
 *
 * REST API endpoints for overview aggregates, rankings, timeline,
 * starred sessions, source capabilities, agent summaries, and status.
 * Powers the KPI hero, rankings, timeline, and module availability
 * in the redesigned dashboard.
 *
 * @module ingest/api/overview
 */

import { Hono } from 'hono';
import { getDatabase } from '../db/index.js';
import { SOURCE_CAPABILITIES } from '../config/capabilities.js';
import { readFileBackedAutomations, type FileAutomationSummary } from './automation-sources.js';
import type { ServiceContext } from '../types.js';
import {
  estimateModelCost,
  rollUpCosts,
  type CostRollup,
  type PricingStatus,
  type TokenUsageForPricing,
  type ModelCostEstimate,
} from '../pricing/model-pricing.js';
import {
  getCanonicalModelKey,
  getDisplayModelName,
} from '../pricing/normalize-model.js';

import { getSessionUsageCosts } from '../pricing/session-pricing.js';

export const overviewRoutes = new Hono();

const VALID_SOURCES = ['openclaw', 'claude-code', 'codex', 'opencode', 'qoder'] as const;

const UPDATED_AT_EXPR =
  "CASE WHEN source = 'qoder' THEN MAX(COALESCE(ended_at, ''), COALESCE(started_at, '')) ELSE MAX(COALESCE(ended_at, ''), COALESCE(started_at, ''), COALESCE(file_mtime, '')) END";

function sessionTotalTokensExpr(alias?: string): string {
  const prefix = alias ? `${alias}.` : '';
  const channelTotal = `COALESCE(${prefix}total_input_tokens, 0) + COALESCE(${prefix}total_output_tokens, 0) + COALESCE(${prefix}total_cache_read_tokens, 0) + COALESCE(${prefix}total_cache_write_tokens, 0) + COALESCE(${prefix}total_reasoning_tokens, 0)`;
  return `CASE WHEN ${prefix}source = 'opencode' THEN ${channelTotal} WHEN COALESCE(${prefix}total_tokens, 0) > 0 THEN ${prefix}total_tokens ELSE ${channelTotal} END`;
}

type IngestDatabase = ReturnType<typeof getDatabase>;
type SqlParam = string | number;

interface SessionCostRow extends TokenUsageForPricing {
  id: string;
  project: string;
  day: string | null;
  model: string | null;
  relationshipType: string | null;
  totalTokens: number;
  source: string;
  sourceCostUsd: number | null;
  costPricingStatus: string | null;
  costEstimate?: ModelCostEstimate;
}

interface DailyTokenRow {
  date: string;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

// ============================================================================
// Shared Helpers
// ============================================================================

function getDateCondition(column: string, window: string): string | null {
  // started_at is stored as a UTC ISO string; convert both it and the
  // threshold to local wall-clock so day boundaries follow the user's timezone.
  switch (window) {
    case 'today':
      return `datetime(${column}, 'localtime') >= datetime('now', 'localtime', 'start of day')`;
    case '7d':
      return `datetime(${column}, 'localtime') >= datetime('now', 'localtime', '-7 days')`;
    case '30d':
      return `datetime(${column}, 'localtime') >= datetime('now', 'localtime', '-30 days')`;
    default:
      return null;
  }
}

function getRollupDateCondition(column: string, window: string): string | null {
  // usage_date is a local-day key (see dateKeyFromTimestamp); compare against
  // local 'now' so the window aligns with the user's timezone.
  switch (window) {
    case 'today':
      return `${column} = date('now', 'localtime')`;
    case '7d':
      return `${column} >= date('now', 'localtime', '-6 days')`;
    case '30d':
      return `${column} >= date('now', 'localtime', '-29 days')`;
    default:
      return null;
  }
}

function parseDaysParam(rawDays: string | undefined): number | null {
  const days = Number.parseInt(rawDays || '30', 10);
  if (!Number.isFinite(days) || days < 1 || days > 90) return null;
  return days;
}

function isValidSource(source: string): source is typeof VALID_SOURCES[number] {
  return (VALID_SOURCES as readonly string[]).includes(source);
}

function getSessionCostRows(
  db: IngestDatabase,
  whereClause: string,
  params: SqlParam[],
): SessionCostRow[] {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.source,
      s.project,
      date(s.started_at) AS day,
      s.relationship_type,
      (
        SELECT m.model
        FROM messages m
        WHERE m.session_id = s.id
          AND TRIM(COALESCE(m.model, '')) <> ''
          AND m.model <> '<synthetic>'
        ORDER BY m.ordinal DESC
        LIMIT 1
      ) AS model,
      COALESCE(s.total_input_tokens, 0) AS input_tokens,
      COALESCE(s.total_output_tokens, 0) AS output_tokens,
      COALESCE(s.total_cache_read_tokens, 0) AS cache_read_tokens,
      COALESCE(s.total_cache_write_tokens, 0) AS cache_write_tokens,
      COALESCE(s.total_reasoning_tokens, 0) AS reasoning_tokens,
      ${sessionTotalTokensExpr('s')} AS total_tokens,
      s.source_cost_usd,
      s.cost_pricing_status
    FROM sessions s
    ${whereClause}
  `).all(...params) as Array<{
    id: string;
    source: string;
    project: string;
    day: string | null;
    relationship_type: string | null;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    source_cost_usd: number | null;
    cost_pricing_status: string | null;
  }>;

  const mapped = rows.map((row) => ({
    id: row.id,
    source: row.source,
    project: row.project,
    day: row.day,
    model: row.model,
    relationshipType: row.relationship_type,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    sourceCostUsd: row.source_cost_usd,
    costPricingStatus: row.cost_pricing_status,
  }));
  return expandSessionCostRows(db, mapped, false);
}

function getDailyTokenCostRows(
  db: IngestDatabase,
  whereClause: string,
  params: SqlParam[],
): SessionCostRow[] {
  const sessionTotalExpr = sessionTotalTokensExpr('s');
  const rows = db.prepare(`
    SELECT
      std.session_id AS id,
      s.source,
      std.project,
      std.usage_date AS day,
      s.relationship_type,
      (
        SELECT m.model
        FROM messages m
        WHERE m.session_id = std.session_id
          AND TRIM(COALESCE(m.model, '')) <> ''
          AND m.model <> '<synthetic>'
        ORDER BY m.ordinal DESC
        LIMIT 1
      ) AS model,
      COALESCE(std.input_tokens, 0) AS input_tokens,
      COALESCE(std.output_tokens, 0) AS output_tokens,
      COALESCE(std.cache_read_tokens, 0) AS cache_read_tokens,
      COALESCE(std.cache_write_tokens, 0) AS cache_write_tokens,
      COALESCE(std.reasoning_tokens, 0) AS reasoning_tokens,
      COALESCE(std.total_tokens, 0) AS total_tokens,
      CASE
        WHEN s.source_cost_usd IS NOT NULL AND ${sessionTotalExpr} > 0
          THEN s.source_cost_usd * COALESCE(std.total_tokens, 0) / ${sessionTotalExpr}
        WHEN s.source_cost_usd IS NOT NULL
          THEN s.source_cost_usd
        ELSE NULL
      END AS source_cost_usd,
      CASE WHEN s.source_cost_usd IS NOT NULL THEN s.cost_pricing_status ELSE NULL END AS cost_pricing_status
    FROM session_token_daily std
    JOIN sessions s ON s.id = std.session_id
    ${whereClause}
  `).all(...params) as Array<{
    id: string;
    source: string;
    project: string;
    day: string | null;
    relationship_type: string | null;
    model: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    source_cost_usd: number | null;
    cost_pricing_status: string | null;
  }>;

  const mapped = rows.map((row) => ({
    id: row.id,
    source: row.source,
    project: row.project,
    day: row.day,
    model: row.model,
    relationshipType: row.relationship_type,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    sourceCostUsd: row.source_cost_usd,
    costPricingStatus: row.cost_pricing_status,
  }));
  return expandSessionCostRows(db, mapped, true);
}

function expandSessionCostRows(
  db: IngestDatabase,
  rows: SessionCostRow[],
  daily: boolean,
): SessionCostRow[] {
  const costsBySession = new Map<string, ReturnType<typeof getSessionUsageCosts>>();
  return rows.flatMap((row) => {
    let entries = costsBySession.get(row.id);
    if (!entries) {
      entries = getSessionUsageCosts(db, row.id);
      costsBySession.set(row.id, entries);
    }
    if (row.sourceCostUsd != null) {
      // A source total has no per-model split; attribute it only when the
      // transcript identifies one model, rather than assigning it to the last.
      return [{ ...row, model: entries[0]?.model ?? null,
        costEstimate: { cost: row.sourceCostUsd,
          pricingStatus: row.costPricingStatus === 'partial' ? 'partial' as const : 'priced' as const } }];
    }
    const selected = entries.filter((entry) => !daily || !entry.day || entry.day === row.day);
    if (selected.length === 0) {
      // All known requests belong to another day (for example repeated snapshots
      // spanning midnight); do not bill the same request on both dates.
      return [{ ...row, inputTokens: 0, outputTokens: 0, totalTokens: 0,
        costEstimate: { cost: 0, pricingStatus: 'priced' as const } }];
    }
    return selected.map((entry) => {
      if (entry.aggregateFallback) {
        return { ...row, model: entry.model, costEstimate: entry.estimate.cost === null
          ? entry.estimate : estimateModelCost(entry.model, row) };
      }
      const usage = entry.usage;
      const estimate = daily && !entry.day ? { cost: null, pricingStatus: 'unknown' as const } : entry.estimate;
      return { ...row, ...usage, model: entry.model,
        totalTokens: entry.totalTokens ?? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.reasoningTokens,
        costEstimate: estimate };
    });
  });
}

function rollUpSessionCosts(rows: SessionCostRow[]): CostRollup {
  return rollUpCosts(rows
    .filter((row) => !(row.source === 'qoder' && row.relationshipType === 'subagent'))
    .filter((row) => row.sourceCostUsd != null || row.totalTokens > 0 || row.costEstimate != null)
    .map((row) => row.costEstimate ?? { cost: null, pricingStatus: 'unknown' }));
}

function emptyDailyTokenRow(date: string): DailyTokenRow {
  return {
    date,
    session_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  };
}

function fillDailyTokenDateRange(rows: DailyTokenRow[]): DailyTokenRow[] {
  if (rows.length === 0) return [];

  const firstDate = rows[0].date;
  const lastDate = rows[rows.length - 1].date;
  const start = new Date(`${firstDate}T00:00:00.000Z`);
  const end = new Date(`${lastDate}T00:00:00.000Z`);

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    return rows;
  }

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const filled: DailyTokenRow[] = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    filled.push(byDate.get(date) ?? emptyDailyTokenRow(date));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return filled;
}

// ============================================================================
// 1. GET /api/v1/overview/aggregates (DATA-101)
// ============================================================================

overviewRoutes.get('/api/v1/overview/aggregates', (c) => {
  const source = c.req.query('source');
  const window = c.req.query('window') || '7d';

  // Validate source
  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  // Validate window
  const dateCondition = getDateCondition('started_at', window);
  const rollupDateCondition = getRollupDateCondition('std.usage_date', window);
  if (!['today', '7d', '30d', 'all'].includes(window)) {
    return c.json({ error: 'Invalid window parameter. Must be "today", "7d", "30d", or "all"' }, 400);
  }

  const db = getDatabase();

  const conditions: string[] = [];
  const params: string[] = [];
  const rollupConditions: string[] = [];
  const rollupParams: SqlParam[] = [];

  if (source) {
    conditions.push('source = ?');
    params.push(source);
    rollupConditions.push('std.source = ?');
    rollupParams.push(source);
  }

  if (dateCondition) {
    conditions.push(dateCondition);
  }

  if (rollupDateCondition) {
    rollupConditions.push(rollupDateCondition);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rollupWhereClause = rollupConditions.length > 0 ? `WHERE ${rollupConditions.join(' AND ')}` : '';

  const result = db.prepare(`
    SELECT
      COUNT(*) as session_count,
      COUNT(DISTINCT project) as project_count,
      COALESCE(SUM(user_message_count), 0) as turn_count
    FROM sessions
    ${whereClause}
  `).get(...params) as {
    session_count: number;
    project_count: number;
    turn_count: number;
  };

  const tokenResult = db.prepare(`
    SELECT
      COALESCE(SUM(std.input_tokens), 0) as input_tokens,
      COALESCE(SUM(std.output_tokens), 0) as output_tokens,
      COALESCE(SUM(std.cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(std.cache_write_tokens), 0) as cache_write_tokens,
      COALESCE(SUM(std.reasoning_tokens), 0) as reasoning_tokens,
      COALESCE(SUM(std.total_tokens), 0) as total_tokens
    FROM session_token_daily std
    ${rollupWhereClause}
  `).get(...rollupParams) as {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  };

  const costSummary = rollUpSessionCosts(getDailyTokenCostRows(db, rollupWhereClause, rollupParams));

  return c.json({
    sessionCount: result.session_count,
    turnCount: result.turn_count,
    projectCount: result.project_count,
    inputTokens: tokenResult.input_tokens,
    outputTokens: tokenResult.output_tokens,
    cacheReadTokens: tokenResult.cache_read_tokens,
    cacheWriteTokens: tokenResult.cache_write_tokens,
    reasoningTokens: tokenResult.reasoning_tokens,
    totalTokens: tokenResult.total_tokens,
    totalCost: costSummary.cost,
    pricingStatus: costSummary.pricingStatus,
  });
});

// ============================================================================
// 2. GET /api/v1/overview/daily-tokens
// ============================================================================

overviewRoutes.get('/api/v1/overview/daily-tokens', (c) => {
  const source = c.req.query('source');
  const window = c.req.query('window');
  const allTime = window === 'all';
  const days = allTime ? null : parseDaysParam(c.req.query('days'));

  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  if (window && !allTime) {
    return c.json({ error: 'Invalid window parameter. Must be "all" when provided' }, 400);
  }

  if (!allTime && days === null) {
    return c.json({ error: 'Invalid days parameter. Must be an integer from 1 to 90' }, 400);
  }

  const db = getDatabase();
  const boundedDays = days ?? 30;
  const sourceFilter = source ? 'AND std.source = ?' : '';
  const rows = allTime
    ? db.prepare(`
      SELECT
        std.usage_date AS date,
        COUNT(DISTINCT std.session_id) AS session_count,
        COALESCE(SUM(std.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(std.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(std.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(std.cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(std.reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(std.total_tokens), 0) AS total_tokens
      FROM session_token_daily std
      WHERE std.usage_date IS NOT NULL
        ${sourceFilter}
      GROUP BY std.usage_date
      ORDER BY std.usage_date ASC
    `).all(...(source ? [source] : [])) as DailyTokenRow[]
    : (() => {
      const sinceModifier = `-${boundedDays - 1} days`;
      const params: Array<string | number> = [
        sinceModifier,
        boundedDays,
        sinceModifier,
        ...(source ? [source] : []),
      ];
      return db.prepare(`
        WITH RECURSIVE day_series(day, n) AS (
          SELECT date('now', 'localtime', ?), 1
          UNION ALL
          SELECT date(day, '+1 day'), n + 1
          FROM day_series
          WHERE n < ?
        ),
        session_daily AS (
          SELECT
            std.usage_date AS day,
            COUNT(DISTINCT std.session_id) AS session_count,
            COALESCE(SUM(std.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(std.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(std.cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(std.cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(std.reasoning_tokens), 0) AS reasoning_tokens,
            COALESCE(SUM(std.total_tokens), 0) AS total_tokens
          FROM session_token_daily std
          WHERE std.usage_date >= date('now', 'localtime', ?)
            AND std.usage_date <= date('now', 'localtime')
            ${sourceFilter}
          GROUP BY std.usage_date
        )
        SELECT
          ds.day AS date,
          COALESCE(sd.session_count, 0) AS session_count,
          COALESCE(sd.input_tokens, 0) AS input_tokens,
          COALESCE(sd.output_tokens, 0) AS output_tokens,
          COALESCE(sd.cache_read_tokens, 0) AS cache_read_tokens,
          COALESCE(sd.cache_write_tokens, 0) AS cache_write_tokens,
          COALESCE(sd.reasoning_tokens, 0) AS reasoning_tokens,
          COALESCE(sd.total_tokens, 0) AS total_tokens
        FROM day_series ds
        LEFT JOIN session_daily sd ON sd.day = ds.day
        ORDER BY ds.day ASC
      `).all(...params) as DailyTokenRow[];
    })();
  const responseRows = allTime ? fillDailyTokenDateRange(rows) : rows;

  const costParams: SqlParam[] = allTime
    ? [...(source ? [source] : [])]
    : [
      `-${boundedDays - 1} days`,
      ...(source ? [source] : []),
    ];
  const costWindowFilter = allTime
    ? ''
    : `
        AND std.usage_date >= date('now', 'localtime', ?)
        AND std.usage_date <= date('now', 'localtime')
      `;

  const costRows = getDailyTokenCostRows(
    db,
    `
      WHERE std.usage_date IS NOT NULL
        ${costWindowFilter}
        ${sourceFilter}
    `,
    costParams,
  );
  const costByDate = new Map<string, CostRollup>();
  const rowsByDate = new Map<string, SessionCostRow[]>();

  for (const row of costRows) {
    if (!row.day) continue;
    rowsByDate.set(row.day, [...(rowsByDate.get(row.day) ?? []), row]);
  }

  for (const [day, dayRows] of rowsByDate) {
    costByDate.set(day, rollUpSessionCosts(dayRows));
  }

  return c.json({
    days: responseRows.map((row) => {
      const costSummary = costByDate.get(row.date);
      return {
        date: row.date,
        sessionCount: row.session_count,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
        totalTokens: row.total_tokens,
        cost: costSummary?.cost ?? null,
        pricingStatus: costSummary?.pricingStatus ?? 'unknown',
      };
    }),
  });
});

// ============================================================================
// 3. GET /api/v1/overview/top-models (DATA-102)
// ============================================================================

overviewRoutes.get('/api/v1/overview/top-models', (c) => {
  const source = c.req.query('source');
  const window = c.req.query('window') || '7d';
  const rawLimit = parseInt(c.req.query('limit') || '10', 10);
  const sortBy = c.req.query('sortBy') || 'tokens';

  // Validate source
  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  // Validate sortBy
  const validSortBy = ['tokens', 'cost'];
  if (sortBy && !validSortBy.includes(sortBy)) {
    return c.json({ error: 'Invalid sortBy parameter. Must be "tokens" or "cost"' }, 400);
  }

  // Validate and cap limit
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 10 : rawLimit, 1), 50);

  const dateCondition = getDateCondition('s.started_at', window);

  const db = getDatabase();

  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (source) {
    conditions.push('s.source = ?');
    params.push(source);
  }

  if (dateCondition) {
    conditions.push(dateCondition);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total tokens across all models for share percentage
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(${sessionTotalTokensExpr('s')}), 0) as total_tokens
    FROM sessions s
    ${whereClause}
  `).get(...params) as { total_tokens: number };

  const costRows = getSessionCostRows(db, whereClause, params);
  const models = costRows.filter((row) => row.model != null).map((row) => ({
    name: row.model!, sessionId: row.id,
    input_tokens: row.inputTokens, output_tokens: row.outputTokens,
    cache_read_tokens: row.cacheReadTokens ?? 0, cache_write_tokens: row.cacheWriteTokens ?? 0,
    reasoning_tokens: row.reasoningTokens ?? 0, total_tokens: row.totalTokens,
  }));

  const mergedByCanonicalModel = new Map<string, {
    canonicalName: string;
    sessionCount: number;
    sessionIds: Set<string>;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  }>();

  for (const modelRow of models) {
    const canonicalName = getCanonicalModelKey(modelRow.name);
    if (!canonicalName) continue;

    const existing = mergedByCanonicalModel.get(canonicalName);
    if (existing) {
      existing.sessionCount = existing.sessionIds.add(modelRow.sessionId).size;
      existing.inputTokens += modelRow.input_tokens;
      existing.outputTokens += modelRow.output_tokens;
      existing.cacheReadTokens += modelRow.cache_read_tokens;
      existing.cacheWriteTokens += modelRow.cache_write_tokens;
      existing.reasoningTokens += modelRow.reasoning_tokens;
      existing.totalTokens += modelRow.total_tokens;
      continue;
    }

    mergedByCanonicalModel.set(canonicalName, {
      canonicalName,
      sessionCount: 1,
      sessionIds: new Set([modelRow.sessionId]),
      inputTokens: modelRow.input_tokens,
      outputTokens: modelRow.output_tokens,
      cacheReadTokens: modelRow.cache_read_tokens,
      cacheWriteTokens: modelRow.cache_write_tokens,
      reasoningTokens: modelRow.reasoning_tokens,
      totalTokens: modelRow.total_tokens,
    });
  }

  const costByCanonicalModel = new Map<string, CostRollup>();
  const canonicalCostModels = new Set(
    costRows
      .map((row) => getCanonicalModelKey(row.model))
      .filter((model): model is string => model != null),
  );

  for (const canonicalName of canonicalCostModels) {
    costByCanonicalModel.set(
      canonicalName,
      rollUpSessionCosts(costRows.filter((row) => getCanonicalModelKey(row.model) === canonicalName)),
    );
  }

  const mapped = [...mergedByCanonicalModel.values()].map((model) => {
    const costSummary = costByCanonicalModel.get(model.canonicalName);

    return {
      name: getDisplayModelName(model.canonicalName) ?? model.canonicalName,
      sessionCount: model.sessionCount,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cacheReadTokens: model.cacheReadTokens,
      cacheWriteTokens: model.cacheWriteTokens,
      reasoningTokens: model.reasoningTokens,
      totalTokens: model.totalTokens,
      sharePercent:
        totalRow.total_tokens > 0
          ? Math.round((model.totalTokens / totalRow.total_tokens) * 10000) / 100
          : 0,
      cost: costSummary?.cost ?? null,
      pricingStatus: costSummary?.pricingStatus ?? 'unknown',
    };
  });

  // Sort by cost when requested (nulls last)
  const result = sortBy === 'cost'
    ? [...mapped].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
    : [...mapped].sort((a, b) => b.totalTokens - a.totalTokens);

  return c.json({ models: result.slice(0, limit) });
});

// ============================================================================
// 3. GET /api/v1/overview/top-projects (DATA-103)
// ============================================================================

overviewRoutes.get('/api/v1/overview/top-projects', (c) => {
  const source = c.req.query('source');
  const window = c.req.query('window') || '7d';
  const rawLimit = parseInt(c.req.query('limit') || '10', 10);
  const sortBy = c.req.query('sortBy') || 'tokens';

  if (!['tokens', 'cost'].includes(sortBy)) {
    return c.json({ error: 'Invalid sortBy parameter. Must be "tokens" or "cost"' }, 400);
  }

  // Validate source
  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  // Validate and cap limit
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 10 : rawLimit, 1), 50);

  const dateCondition = getDateCondition('s.started_at', window);

  const db = getDatabase();

  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (source) {
    conditions.push('s.source = ?');
    params.push(source);
  }

  if (dateCondition) {
    conditions.push(dateCondition);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total tokens across all projects for rank weight
  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(${sessionTotalTokensExpr('s')}), 0) as total_tokens
    FROM sessions s
    ${whereClause}
  `).get(...params) as { total_tokens: number };

  const projects = db.prepare(`
    SELECT
      s.project AS project,
      COUNT(*) as session_count,
      COALESCE(SUM(s.user_message_count), 0) as turn_count,
      COALESCE(SUM(s.total_input_tokens), 0) as input_tokens,
      COALESCE(SUM(s.total_output_tokens), 0) as output_tokens,
      COALESCE(SUM(s.total_cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(s.total_cache_write_tokens), 0) as cache_write_tokens,
      COALESCE(SUM(s.total_reasoning_tokens), 0) as reasoning_tokens,
      COALESCE(SUM(${sessionTotalTokensExpr('s')}), 0) as total_tokens
    FROM sessions s
    ${whereClause}
    GROUP BY s.project
    ORDER BY total_tokens DESC
  `).all(...params) as Array<{
    project: string;
    session_count: number;
    turn_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  }>;

  const costRows = getSessionCostRows(db, whereClause, params);
  const costByProject = new Map<string, CostRollup>();

  for (const project of new Set(costRows.map((row) => row.project))) {
    costByProject.set(
      project,
      rollUpSessionCosts(costRows.filter((row) => row.project === project)),
    );
  }

  const mapped = projects.map((p) => {
    const costSummary = costByProject.get(p.project);
    return {
      project: p.project,
      sessionCount: p.session_count,
      turnCount: p.turn_count,
      inputTokens: p.input_tokens,
      outputTokens: p.output_tokens,
      cacheReadTokens: p.cache_read_tokens,
      cacheWriteTokens: p.cache_write_tokens,
      reasoningTokens: p.reasoning_tokens,
      totalTokens: p.total_tokens,
      rankWeight:
        totalRow.total_tokens > 0
          ? Math.round((p.total_tokens / totalRow.total_tokens) * 10000) / 100
          : 0,
      cost: costSummary?.cost ?? null,
      pricingStatus: costSummary?.pricingStatus ?? ('unknown' as PricingStatus),
    };
  });

  const result = sortBy === 'cost'
    ? [...mapped].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
    : mapped;

  return c.json({ projects: result.slice(0, limit) });
});

// ============================================================================
// 4. GET /api/v1/overview/starred (DATA-104)
// ============================================================================

overviewRoutes.get('/api/v1/overview/starred', (c) => {
  const source = c.req.query('source');
  const rawLimit = parseInt(c.req.query('limit') || '20', 10);

  // Validate source
  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  // Validate and cap limit
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 20 : rawLimit, 1), 100);

  const db = getDatabase();

  const conditions: string[] = [];
  const params: SqlParam[] = [];

  if (source) {
    conditions.push('s.source = ?');
    params.push(source);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

  const starred = db.prepare(`
    SELECT
      s.id,
      s.name,
      s.source,
      s.project,
      s.status,
      s.started_at as startedAt,
      ${UPDATED_AT_EXPR} as updatedAt,
      ss.starred_at as starredAt
    FROM session_stars ss
    JOIN sessions s ON s.id = ss.session_id
    WHERE 1=1 ${whereClause}
    ORDER BY ss.starred_at DESC
    LIMIT ?
  `).all(...params, limit) as Array<{
    id: string;
    name: string | null;
    source: string;
    project: string;
    status: string;
    startedAt: string | null;
    updatedAt: string;
    starredAt: string;
  }>;

  return c.json({
    starred: starred.map((row) => ({
      id: row.id,
      name: row.name || undefined,
      source: row.source,
      project: row.project,
      status: row.status,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt || undefined,
      starredAt: row.starredAt,
    })),
  });
});

// ============================================================================
// 5. GET /api/v1/overview/timeline (DATA-105)
// ============================================================================

overviewRoutes.get('/api/v1/overview/timeline', (c) => {
  const source = c.req.query('source');
  const rawLimit = parseInt(c.req.query('limit') || '50', 10);

  // Validate source
  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  // Validate and cap limit
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 200);

  const db = getDatabase();

  const sourceFilter = source ? `AND source = ?` : '';
  const sourceFilterSync = source ? `AND source_type = ?` : '';

  // Each UNION branch has its own params array for clarity
  const p1: string[] = source ? [source] : [];
  const p2: string[] = source ? [source] : [];
  const p3: string[] = source ? [source] : [];
  const p4: string[] = source ? [source] : [];
  const p5: string[] = source ? [source] : [];

  const timeline = db.prepare(`
    SELECT * FROM (
      SELECT id, source, project, name, 'session_started' as event_type,
             started_at as event_time, status, NULL as error_message
      FROM sessions
      WHERE started_at IS NOT NULL ${sourceFilter}

      UNION ALL

      SELECT id, source, project, name, 'session_completed' as event_type,
             ended_at as event_time, status, NULL as error_message
      FROM sessions
      WHERE ended_at IS NOT NULL AND status IN ('idle', 'aborted')
      ${source ? 'AND source = ?' : ''}

      UNION ALL

      SELECT id, source, project, name, 'session_error' as event_type,
             COALESCE(ended_at, started_at) as event_time, status,
             termination_status as error_message
      FROM sessions
      WHERE status = 'error' ${sourceFilter}

      UNION ALL

      SELECT id, source, project, agent_name as name,
             'automation_completed' as event_type,
             ended_at as event_time, status, NULL as error_message
      FROM sessions
      WHERE agent_name IS NOT NULL
        AND user_message_count = 0
        AND ended_at IS NOT NULL
        AND status IN ('idle', 'aborted')
      ${source ? 'AND source = ?' : ''}

      UNION ALL

      SELECT source_type as id, source_type as source, '' as project, '' as name,
             'sync_error' as event_type, datetime('now') as event_time,
             'error' as status, last_error as error_message
      FROM sync_status
      WHERE last_error IS NOT NULL ${sourceFilterSync}
    )
    ORDER BY event_time DESC
    LIMIT ?
  `).all(
    ...p1,
    ...p2,
    ...p3,
    ...p4,
    ...p5,
    limit,
  ) as Array<{
    id: string;
    source: string;
    project: string;
    name: string;
    event_type: string;
    event_time: string | null;
    status: string;
    error_message: string | null;
  }>;

  return c.json({
    timeline: timeline.map((row) => ({
      id: buildTimelineEventId(row),
      source: row.source,
      eventType: row.event_type,
      eventTime: row.event_time,
      project: row.project || undefined,
      name: row.name || undefined,
      status: row.status,
      errorMessage: row.error_message || undefined,
    })),
  });
});

function buildTimelineEventId(row: {
  id: string;
  source: string;
  event_type: string;
  event_time: string | null;
}): string {
  return [
    row.source,
    row.id,
    row.event_type,
    row.event_time || 'unknown',
  ].join(':');
}

// ============================================================================
// 6. GET /api/v1/overview/capabilities (DATA-106)
// ============================================================================

overviewRoutes.get('/api/v1/overview/capabilities', (c) => {
  return c.json({
    capabilities: SOURCE_CAPABILITIES,
    sources: [...VALID_SOURCES],
  });
});

// ============================================================================
// 7. GET /api/v1/overview/agents (OPEN-101)
// ============================================================================

overviewRoutes.get('/api/v1/overview/agents', (c) => {
  const source = c.req.query('source');

  // Source is required for agents endpoint
  if (!source) {
    return c.json({ error: 'source query parameter is required' }, 400);
  }

  if (!isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }

  const db = getDatabase();

  const rows = db.prepare(`
    SELECT
      s.agent_name AS name,
      COUNT(DISTINCT s.id) AS session_count,
      MAX(s.started_at) AS last_active_at,
      (
        SELECT s2.status
        FROM sessions s2
        WHERE s2.source = s.source
          AND s2.agent_name = s.agent_name
        ORDER BY COALESCE(s2.ended_at, s2.started_at) DESC
        LIMIT 1
      ) AS latest_status,
      COALESCE(
        (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id IN (
          SELECT s3.id FROM sessions s3 WHERE s3.source = s.source AND s3.agent_name = s.agent_name
        )),
        0
      ) AS tool_call_count
    FROM sessions s
    WHERE s.source = ? AND s.agent_name IS NOT NULL
    GROUP BY s.agent_name
    ORDER BY last_active_at DESC
  `).all(source) as Array<{
    name: string;
    session_count: number;
    last_active_at: string | null;
    latest_status: string;
    tool_call_count: number;
  }>;

  return c.json({
    agents: rows.map((row) => ({
      name: row.name,
      sessionCount: row.session_count,
      toolCallCount: row.tool_call_count,
      lastActiveAt: row.last_active_at,
      latestStatus: row.latest_status,
    })),
  });
});

// ============================================================================
// 8b. GET /api/v1/overview/automations (OVR-104)
// ============================================================================

overviewRoutes.get('/api/v1/overview/automations', (c) => {
  const source = c.req.query('source');

  if (source && !isValidSource(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400);
  }
  const requestedSource = source as FileAutomationSummary['source'] | undefined;

  const db = getDatabase();

  const conditions = ['s.agent_name IS NOT NULL', 's.user_message_count = 0'];
  const params: string[] = [];
  if (source) {
    conditions.unshift('s.source = ?');
    params.push(source);
  }

  // Session fallback: agent-named sessions with no user input.
  const rows = db.prepare(`
    SELECT
      s.source AS source,
      s.agent_name AS name,
      COUNT(DISTINCT s.id) AS session_count,
      MAX(s.started_at) AS last_active_at,
      (
        SELECT s2.status
        FROM sessions s2
        WHERE s2.source = s.source
          AND s2.agent_name = s.agent_name
          AND s2.user_message_count = 0
        ORDER BY COALESCE(s2.ended_at, s2.started_at) DESC
        LIMIT 1
      ) AS latest_status,
      COALESCE(
        (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id IN (
          SELECT s3.id FROM sessions s3
          WHERE s3.source = s.source
            AND s3.agent_name = s.agent_name
            AND s3.user_message_count = 0
        )),
        0
      ) AS tool_call_count
    FROM sessions s
    WHERE ${conditions.join(' AND ')}
    GROUP BY s.source, s.agent_name
    ORDER BY last_active_at DESC
  `).all(...params) as Array<{
    source: string;
    name: string;
    session_count: number;
    last_active_at: string | null;
    latest_status: string;
    tool_call_count: number;
  }>;

  return c.json({
    automations: mergeAutomationSummaries(
      rows.map((row): FileAutomationSummary => ({
        source: row.source as FileAutomationSummary['source'],
        name: row.name,
        sessionCount: row.session_count,
        toolCallCount: row.tool_call_count,
        lastActiveAt: row.last_active_at,
        latestStatus: row.latest_status,
      })),
      readFileBackedAutomations(requestedSource),
    ).map((row) => ({
      id: row.id,
      source: row.source,
      name: row.name,
      sessionCount: row.sessionCount,
      toolCallCount: row.toolCallCount,
      lastActiveAt: row.lastActiveAt,
      latestStatus: row.latestStatus,
      schedule: row.schedule,
      nextRunAt: row.nextRunAt,
      model: row.model,
    })),
  });
});

type AutomationEndpointRow = FileAutomationSummary;

function mergeAutomationSummaries(
  sessionRows: AutomationEndpointRow[],
  fileRows: AutomationEndpointRow[],
): AutomationEndpointRow[] {
  const merged = new Map<string, AutomationEndpointRow>();

  for (const row of [...sessionRows, ...fileRows]) {
    const key = `${row.source}:${row.name.trim().toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }

    const lastActiveAt = laterDate(existing.lastActiveAt, row.lastActiveAt);
    merged.set(key, {
      ...existing,
      ...row,
      id: existing.id ?? row.id,
      schedule: existing.schedule ?? row.schedule,
      nextRunAt: existing.nextRunAt ?? row.nextRunAt,
      model: existing.model ?? row.model,
      sessionCount: Math.max(existing.sessionCount, row.sessionCount),
      toolCallCount: Math.max(existing.toolCallCount, row.toolCallCount),
      lastActiveAt,
      latestStatus: lastActiveAt === row.lastActiveAt ? row.latestStatus : existing.latestStatus,
    });
  }

  return [...merged.values()].sort((a, b) => {
    const at = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
    const bt = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
    if (bt !== at) return bt - at;
    return a.name.localeCompare(b.name);
  });
}

function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

// ============================================================================
// 8. GET /api/v1/overview/status (OPEN-103)
// ============================================================================

overviewRoutes.get('/api/v1/overview/status', async (c) => {
  // Dynamic import to avoid circular dependency with index.ts at module load time
  let ctx: ServiceContext | null = null;
  try {
    const mod = await import('../index.js');
    ctx = mod.getServiceContext();
  } catch {
    // Service context not available (e.g. in test environment without full service)
  }

  // Ingest status
  const ingest = {
    status: ctx ? 'ok' : 'error',
    uptime: process.uptime(),
    db: ctx?.db ? 'connected' as const : 'disconnected' as const,
  };

  // Watcher status
  const watcherStatus = ctx?.watcher?.getStatus();
  const watcher = {
    status: watcherStatus?.running ? 'watching' as const : 'stopped' as const,
    filesWatched: watcherStatus?.filesWatched ?? 0,
    lastSyncAt: watcherStatus?.lastSyncAt ?? null,
  };

  const sync = ctx?.syncScheduler?.getStatus() ?? null;

  // Gateway status — placeholder per CONTEXT.md deferred ideas
  const gateway = {
    status: 'disconnected' as const,
  };

  return c.json({ ingest, watcher, sync, gateway });
});
