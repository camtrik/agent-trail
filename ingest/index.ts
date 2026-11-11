/**
 * Ingest Service Main Entry Point
 *
 * Starts HTTP API server with health/version endpoints,
 * initializes SQLite database, manages graceful shutdown.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { loadConfig, getConfig } from './config/index.js';
import { openDatabase, initSchema, closeDatabase } from './db/index.js';
import { sourcesRoutes } from './api/sources.js';
import { sessionsRoutes } from './api/sessions.js';
import { turnsRoutes } from './api/turns.js';
import { agentsRoutes } from './api/agents.js';
import { starsRoutes } from './api/stars.js';
import { overviewRoutes } from './api/overview.js';
import { qoderUsageRoutes } from './api/qoder-usage.js';
import { searchRoutes } from './api/search.js';
import { eventsRoutes } from './api/routes/events.js';
import { rateLimiter } from './api/middleware/rate-limit.js';
import { createWatcher } from './src/watcher.js';
import { createSyncScheduler } from './src/sync-scheduler.js';
import { sseManager } from './src/sse.js';
import { logger } from './logger.js';
import {
  discoverClaudeSources,
  discoverCodexSources,
} from './sync/sources.js';
import type { ServiceContext, HealthStatus, StartupSyncState, VersionInfo } from './types.js';
import type { TraceSource } from '../types/trace.js';
import { syncPaths, syncSource, type SyncSourceType } from './sync/index.js';

// ============================================================================
// Module State
// ============================================================================

export const app = new Hono();
let context: ServiceContext | null = null;

/**
 * Get the active service context (lazy accessor for routes)
 */
export function getServiceContext(): ServiceContext | null {
  return context;
}

// ============================================================================
// API Routes
// ============================================================================

/**
 * GET /health - Health check endpoint
 */
app.get('/health', (c) => {
  const health: HealthStatus = {
    status: context ? 'ok' : 'error',
    ready: Boolean(context?.syncState.startupComplete),
    version: '0.1.1',
    uptime: process.uptime(),
    database: context?.db ? 'connected' : 'disconnected',
    sync: context?.syncState
      ? { ...context.syncState, scheduler: context.syncScheduler?.getStatus() ?? null }
      : null,
  };

  return c.json(health);
});

/**
 * GET /version - Version information endpoint
 */
app.get('/version', (c) => {
  const version: VersionInfo = {
    version: '0.1.1',
    name: 'agent-trail-ingest',
    sources: ['openclaw', 'claude-code', 'codex', 'opencode', 'qoder'] as TraceSource[],
  };

  return c.json(version);
});

app.get('/api/v1/debug/sync', (c) => {
  const debug = context?.syncScheduler?.getDebugStatus() ?? {
    activeRun: null,
    queue: { queued: false, queuedReasons: [], coalescedCount: 0 },
    recentRuns: [],
    recentErrors: [],
    metrics: {
      filesConsidered: 0,
      filesSkippedBeforeParse: 0,
      filesParsed: 0,
      filesParsedFully: 0,
      filesParsedIncrementally: 0,
      incrementalFallbacks: 0,
      largestFileBytes: 0,
      messagesWritten: 0,
      toolCallsWritten: 0,
      resultEventsWritten: 0,
      sessionsInserted: 0,
      sessionsUpdated: 0,
      maxRssBytes: 0,
      lastDurationMs: null,
    },
    config: {
      historyLimit: context?.config.syncHistoryLimit ?? 20,
    },
  };

  return c.json({
    ...debug,
    config: {
      ...debug.config,
      parseConcurrency: context?.config.parseConcurrency ?? 1,
      sqliteBatchSize: context?.config.sqliteBatchSize ?? 500,
      historyLimit: context?.config.syncHistoryLimit ?? debug.config.historyLimit,
    },
  });
});

// Mount sources API routes
app.route('/', sourcesRoutes);

// Mount stars before sessions to avoid /sessions/starred hitting /sessions/:id
app.route('/', starsRoutes);
// Mount search before sessions so /sessions/:id/search matches before /sessions/:id
app.route('/', searchRoutes);
app.route('/', sessionsRoutes);
app.route('/', turnsRoutes);
app.route('/', agentsRoutes);
app.route('/', overviewRoutes);
app.route('/', qoderUsageRoutes);

// Mount SSE event routes (global + per-session streams)
app.route('/', eventsRoutes);

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Global error handler — sanitizes error responses in production mode.
 * When INGEST_DEBUG=true, full error details (message + stack) are returned.
 * In production, only "Internal server error" is exposed.
 */
app.onError((err, c) => {
  const config = getConfig();
  if (config.debugMode) {
    return c.json({
      error: err.message,
      stack: err.stack,
    }, 500);
  }
  // Production: generic error, no internals exposed
  return c.json({
    error: 'Internal server error',
  }, 500);
});

// ============================================================================
// Service Lifecycle
// ============================================================================

/**
 * Start ingest service
 */
export async function start(): Promise<void> {
  try {
    // Load configuration
    const config = loadConfig();

    // Apply rate limiter to all routes (when enabled)
    if (config.rateLimitEnabled) {
      app.use('*', rateLimiter);
    }

    // Open database
    logger.info(`Opening database: ${config.dbPath}`);
    const db = openDatabase({ path: config.dbPath });

    // Initialize schema
    logger.info('Initializing database schema...');
    initSchema();

    const syncState: StartupSyncState = {
      phase: 'starting',
      startupComplete: config.startupSyncLimit === 0,
      foregroundLimit: config.startupSyncLimit,
      backgroundSyncEnabled: config.backgroundSyncEnabled,
      currentSource: null,
      lastSyncAt: null,
      lastError: null,
    };

    // Start HTTP server before filesystem discovery and initial indexing. Health
    // reports ready=false until the bounded warmup sync completes, but TCP is
    // available immediately so Next.js startup is no longer blocked by history.
    const server = serve({
      fetch: app.fetch,
      port: config.port,
    });

    const syncScheduler = createSyncScheduler(
      { syncSource, syncPaths },
      { historyLimit: config.syncHistoryLimit }
    );

    // Store context before background initialization so routes/health can answer.
    context = { config, db, server, sseManager, watcher: null, syncScheduler, syncState };

    logger.info(`Ingest service listening on port ${config.port}`);
    logger.debug(`Health check: http://localhost:${config.port}/health`);
    logger.debug(`Version info: http://localhost:${config.port}/version`);

    void initializeSourcesAndSync();
  } catch (err) {
    logger.error('Failed to start ingest service:', err);
    throw err;
  }
}

async function initializeSourcesAndSync(): Promise<void> {
  const active = context;
  if (!active) return;

  try {
    active.syncState.phase = 'discovering';

    // Discover source directories for watcher
    logger.info('Discovering source directories...');
    const claudeSources = await discoverClaudeSources();
    const codexSources = await discoverCodexSources();

    const sourceDirs = new Map<SyncSourceType, string[]>();
    // Watch agent roots so newly created SQLite databases and their WAL sidecars are discovered.
    sourceDirs.set('openclaw', active.config.toolDirs.get('openclaw') ?? []);
    sourceDirs.set('claude-code', claudeSources.filter((s) => !s.error && s.path).map((s) => s.path));
    sourceDirs.set('codex', codexSources.filter((s) => !s.error && s.path).map((s) => s.path));

    // Create watcher before warmup so routes can report it, but start it only
    // after foreground warmup. This prevents startup warmup and file events
    // from overlapping before the scheduler is ready to coalesce work.
    const watcher = createWatcher({
      sourceDirs,
      debounceMs: active.config.debounceMs,
      resyncIntervalMs: active.config.resyncIntervalMs,
      fileExtensions: ['.jsonl', '.json', '.md'],
      onPathsChanged: async (sourceType, paths) => {
        try {
          await active.syncScheduler?.enqueuePaths(sourceType, paths, 'watcher');
        } catch (err) {
          logger.error(`[watcher] Path sync failed for ${sourceType}:`, err);
        }
      },
      onFullResync: async (sourceType) => {
        try {
          await active.syncScheduler?.enqueueFullSource(sourceType, 'periodic');
        } catch (err) {
          logger.error(`[watcher] Periodic sync failed for ${sourceType}:`, err);
        }
      },
    });
    if (context) {
      context.watcher = watcher;
    }

    // Bounded startup warmup: parse a small latest-first slice before reporting
    // ready=true. Full historical indexing continues in the background below.
    const sourceTypes = ['openclaw', 'claude-code', 'codex', 'opencode', 'qoder'] as SyncSourceType[];

    if (active.config.startupSyncLimit > 0) {
      active.syncState.phase = 'warming';
      logger.info(`Running startup warmup sync: latest ${active.config.startupSyncLimit} files per source...`);

      for (const sourceType of sourceTypes) {
        active.syncState.currentSource = sourceType;
        try {
          const result = await active.syncScheduler!.enqueueFullSource(sourceType, 'startup-warmup', {
            limit: active.config.startupSyncLimit,
            sortByMtimeDesc: true,
          });
          active.syncState.lastSyncAt = new Date().toISOString();
          logger.debug(`Warmup sync ${sourceType}: +${result.sessionsInserted} new, ~${result.sessionsUpdated} updated`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          active.syncState.lastError = message;
          logger.error(`Warmup sync failed for ${sourceType}:`, err);
        }
      }
    }

    active.syncState.startupComplete = true;
    active.syncState.currentSource = null;

    logger.info('Starting file watcher...');
    await watcher.start();

    if (!active.config.backgroundSyncEnabled) {
      active.syncState.phase = 'idle';
      logger.info('Background sync disabled; ingest is ready after startup warmup.');
      return;
    }

    active.syncState.phase = 'indexing';
    logger.info('Running background full sync for all sources...');
    for (const sourceType of sourceTypes) {
      active.syncState.currentSource = sourceType;
      try {
        const result = await active.syncScheduler!.enqueueFullSource(sourceType, 'background');
        active.syncState.lastSyncAt = new Date().toISOString();
        logger.debug(`Background sync ${sourceType}: +${result.sessionsInserted} new, ~${result.sessionsUpdated} updated`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        active.syncState.lastError = message;
        logger.error(`Background sync failed for ${sourceType}:`, err);
      }
    }

    active.syncState.phase = 'idle';
    active.syncState.currentSource = null;
  } catch (err) {
    const activeContext = context;
    if (activeContext) {
      activeContext.syncState.phase = 'error';
      activeContext.syncState.startupComplete = true;
      activeContext.syncState.currentSource = null;
      activeContext.syncState.lastError = err instanceof Error ? err.message : String(err);
    }
    logger.error('Failed to initialize sources and sync:', err);
  }
}

/**
 * Stop ingest service
 */
export async function stop(): Promise<void> {
  try {
    if (context?.watcher) {
      logger.info('Stopping file watcher...');
      await context.watcher.stop();
    }

    if (context?.server) {
      logger.info('Stopping HTTP server...');
      context.server.close();
      context.server = null;
    }

    closeDatabase();
    context = null;

    logger.info('Ingest service stopped');
  } catch (err) {
    logger.error('Error during shutdown:', err);
    throw err;
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (require.main === module) {
  start().catch((err) => {
    logger.error('Failed to start ingest service:', err);
    process.exit(1);
  });

  // Graceful shutdown handlers
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, shutting down gracefully...');
    try {
      await stop();
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  });

  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, shutting down gracefully...');
    try {
      await stop();
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
}
