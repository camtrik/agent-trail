/**
 * Sources API Routes
 *
 * REST API endpoints for source discovery, sync triggering, and ingest status.
 * Provides OpenClaw source management in Phase 2, with Claude Code/Codex in Phase 3.
 *
 * @module ingest/api/sources
 */

import { Hono } from 'hono';
import type { TraceSource } from '@/types/trace';
import {
  discoverClaudeSources,
  discoverCodexSources,
  discoverOpenClawSources,
  discoverOpencodeSources,
  discoverQoderSources,
  type DiscoveredSource,
} from '../sync/sources';
import { getServiceContext } from '../index.js';

export const sourcesRoutes = new Hono();

const SOURCE_TYPES: TraceSource[] = ['openclaw', 'claude-code', 'codex', 'opencode', 'qoder'];

function isTraceSource(type: string): type is TraceSource {
  return SOURCE_TYPES.includes(type as TraceSource);
}

async function discoverByType(type: TraceSource): Promise<DiscoveredSource[]> {
  if (type === 'openclaw') return discoverOpenClawSources();
  if (type === 'claude-code') return discoverClaudeSources();
  if (type === 'codex') return discoverCodexSources();
  if (type === 'opencode') return discoverOpencodeSources();
  if (type === 'qoder') return discoverQoderSources();
  return discoverCodexSources();
}

function toSourceResponse(s: DiscoveredSource) {
  const ctx = getServiceContext();
  const watcherStatus = ctx?.watcher?.getStatus()?.running ? 'watching' : 'stopped';
  const filesWatched = ctx?.watcher?.getStatus()?.filesWatched ?? 0;

  return {
    type: s.type,
    path: s.path,
    sessionCount: s.sessionCount,
    lastSyncAt: s.lastSyncAt || null,
    error: s.error || null,
    // Source health status taxonomy per FOUND-05/DATA-03:
    healthStatus: s.error ? 'error' : s.warning ? 'parser-warning' : (s.sessionCount > 0 ? 'configured' : 'empty'),
    ...(s.warning ? { warning: s.warning, unsupportedArchiveCount: s.unsupportedArchiveCount } : {}),
    watcherStatus,  // Phase 6: real-time watcher health
    filesWatched,   // Phase 6: files being monitored
  };
}

// ============================================================================
// GET /api/v1/sources - List all discovered sources
// ============================================================================

sourcesRoutes.get('/api/v1/sources', async (c) => {
  try {
    const discovered = await Promise.all(SOURCE_TYPES.map(discoverByType));
    const sources = discovered.flat().map(toSourceResponse);

    return c.json({
      sources,
      total: sources.length
    });
  } catch (err) {
    return c.json({
      error: 'Failed to discover sources',
      message: err instanceof Error ? err.message : 'Unknown error'
    }, 500);
  }
});

// ============================================================================
// GET /api/v1/sources/:type - Get sources by type
// ============================================================================

sourcesRoutes.get('/api/v1/sources/:type', async (c) => {
  const type = c.req.param('type');

  if (!isTraceSource(type)) {
    return c.json({
      error: 'Unsupported source type',
      message: `Type '${type}' not supported`
    }, 400);
  }

  try {
    const sources = await discoverByType(type);

    return c.json({
      type,
      sources: sources.map(toSourceResponse)
    });
  } catch (err) {
    return c.json({
      error: 'Failed to discover sources',
      message: err instanceof Error ? err.message : 'Unknown error'
    }, 500);
  }
});

// ============================================================================
// POST /api/v1/sources/:type/sync - Trigger sync for source type
// ============================================================================

sourcesRoutes.post('/api/v1/sources/:type/sync', async (c) => {
  const type = c.req.param('type');

  if (!isTraceSource(type)) {
    return c.json({
      error: 'Unsupported source type',
      message: `Type '${type}' not supported`
    }, 400);
  }

  try {
    // Accept force=true via query string or request body
    const queryForce = c.req.query('force');
    let bodyForce = false;
    try {
      const body = await c.req.json().catch(() => ({}));
      bodyForce = body?.force === true || body?.force === 'true';
    } catch {
      // Body may be empty — ignore parse errors
    }
    const force = queryForce === 'true' || bodyForce;

    const ctx = getServiceContext();
    const result = ctx?.syncScheduler
      ? await ctx.syncScheduler.enqueueFullSource(type, 'manual', { force })
      : await (await import('../sync')).syncSource(type, { force });

    return c.json({
      type,
      syncResult: {
        sessionsInserted: result.sessionsInserted,
        sessionsUpdated: result.sessionsUpdated,
        messagesInserted: result.messagesInserted,
        toolCallsInserted: result.toolCallsInserted,
        toolResultEventsInserted: result.toolResultEventsInserted,
        errors: result.errors
      },
      status: 'completed'
    });
  } catch (err) {
    return c.json({
      error: 'Sync failed',
      message: err instanceof Error ? err.message : 'Unknown error'
    }, 500);
  }
});

// ============================================================================
// GET /api/v1/sources/:type/status - Watcher health for a source type
// ============================================================================

sourcesRoutes.get('/api/v1/sources/:type/status', (c) => {
  const type = c.req.param('type');

  if (!isTraceSource(type)) {
    return c.json({
      error: 'Unsupported source type',
      message: `Type '${type}' not supported`
    }, 400);
  }

  const ctx = getServiceContext();
  const status = ctx?.watcher?.getStatus();

  return c.json({
    type,
    watcherStatus: status?.running ? 'watching' : 'stopped',
    filesWatched: status?.filesWatched ?? 0,
    lastSyncAt: status?.lastSyncAt ?? null,
    lastError: status?.lastError ?? null,
    sync: ctx?.syncScheduler?.getStatus() ?? null,
  });
});
