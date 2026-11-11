/**
 * File Watcher Service
 *
 * Uses chokidar for cross-platform file watching on source directories.
 * Provides debounce (500ms default), periodic resync fallback (15 min default),
 * temp file filtering, and graceful error handling.
 *
 * @module ingest/src/watcher
 */

import * as chokidar from 'chokidar';
import * as fs from 'fs/promises';
import { logger } from '../logger';
import { openClawDatabasePathForChange } from '../parser/openclaw-sqlite';
import type { SyncSourceType } from '../sync/index.js';

// ============================================================================
// Types
// ============================================================================

export interface WatcherConfig {
  /** Map of source type to watched directory paths */
  sourceDirs: Map<SyncSourceType, string[]>;
  /** Debounce window in milliseconds (default 500) */
  debounceMs: number;
  /** Periodic resync interval in milliseconds (default 900000 = 15 min) */
  resyncIntervalMs: number;
  /** File extensions to watch (default ['.jsonl', '.json', '.md']) */
  fileExtensions: string[];
  /** Callback invoked when files change and debounce fires */
  onPathsChanged: (sourceType: SyncSourceType, paths: string[]) => void | Promise<void>;
  /** Callback invoked by periodic full-source resync fallback */
  onFullResync: (sourceType: SyncSourceType) => void | Promise<void>;
}

export interface WatcherStatus {
  /** Whether the watcher is actively watching */
  running: boolean;
  /** Number of files currently being watched across all sources */
  filesWatched: number;
  /** ISO timestamp of the last sync operation */
  lastSyncAt: string | null;
  /** Last error message, if any */
  lastError: string | null;
  /** Number of source types being watched */
  sourceCount: number;
}

export interface WatcherInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): WatcherStatus;
}

// ============================================================================
// Temp file suffixes to ignore
// ============================================================================

const TEMP_FILE_SUFFIXES = ['~', '.swp', '.swo', '.tmp', '.temp', '.bak'];
const TEMP_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);

function isTempFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() || filePath;
  if (TEMP_FILE_NAMES.has(basename)) return true;
  for (const suffix of TEMP_FILE_SUFFIXES) {
    if (basename.endsWith(suffix)) return true;
  }
  return false;
}

function isValidExtension(filePath: string, extensions: string[]): boolean {
  return extensions.some((ext) => filePath.endsWith(ext));
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a file watcher that monitors source directories for session file changes.
 *
 * Uses chokidar to watch directories for add/change/unlink events on configured
 * file extensions, with temp file filtering and debounce. Falls back to periodic
 * directory-consistency resync at the configured interval.
 *
 * @param config - Watcher configuration
 * @returns WatcherInstance with start/stop/getStatus lifecycle
 */
export function createWatcher(config: WatcherConfig): WatcherInstance {
  // ==========================================================================
  // Internal State
  // ==========================================================================

  const pendingPaths = new Map<SyncSourceType, Set<string>>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let resyncInterval: ReturnType<typeof setInterval> | null = null;
  const chokidarWatchers = new Map<string, chokidar.FSWatcher>();
  const status: WatcherStatus = {
    running: false,
    filesWatched: 0,
    lastSyncAt: null,
    lastError: null,
    sourceCount: 0,
  };

  // ==========================================================================
  // Debounce Logic
  // ==========================================================================

  function resetDebounceTimer(): void {
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(async () => {
      debounceTimer = null;

      // Fire path-scoped sync for each source type that has pending paths
      for (const [sourceType, paths] of pendingPaths.entries()) {
        if (paths.size > 0) {
          try {
            await config.onPathsChanged(sourceType, Array.from(paths).sort());
            status.lastSyncAt = new Date().toISOString();
          } catch (err) {
            status.lastError = err instanceof Error ? err.message : String(err);
            logger.error(`[watcher] Sync error for ${sourceType}:`, err);
          }
        }
      }

      pendingPaths.clear();
    }, config.debounceMs);
  }

  // ==========================================================================
  // Path Registration
  // ==========================================================================

  function registerPath(sourceType: SyncSourceType, filePath: string): void {
    const openClawDb = sourceType === 'openclaw' ? openClawDatabasePathForChange(filePath) : undefined;
    const openClawArchive = sourceType === 'openclaw' && /\.jsonl\.(?:deleted\.|reset\.|full\.bak$)/.test(filePath);
    if (!openClawDb && !openClawArchive && !isValidExtension(filePath, config.fileExtensions)) return;
    if (!openClawArchive && isTempFile(filePath)) return;
    filePath = openClawDb ?? filePath;

    // Add to pending set
    if (!pendingPaths.has(sourceType)) {
      pendingPaths.set(sourceType, new Set());
    }
    pendingPaths.get(sourceType)!.add(filePath);

    // Reset debounce timer
    resetDebounceTimer();
  }

  // ==========================================================================
  // Periodic Resync
  // ==========================================================================

  function runPeriodicResync(): void {
    for (const sourceType of config.sourceDirs.keys()) {
      try {
        const result = config.onFullResync(sourceType);
        if (result instanceof Promise) {
          result.catch((err) => {
            status.lastError = err instanceof Error ? err.message : String(err);
            logger.error(`[watcher] Periodic resync error for ${sourceType}:`, err);
          });
        }
      } catch (err) {
        status.lastError = err instanceof Error ? err.message : String(err);
        logger.error(`[watcher] Periodic resync error for ${sourceType}:`, err);
      }
    }
    status.lastSyncAt = new Date().toISOString();
  }

  // ==========================================================================
  // Lifecycle: start()
  // ==========================================================================

  async function start(): Promise<void> {
    if (status.running) {
      logger.debug('[watcher] Already running, skipping start');
      return;
    }

    status.sourceCount = config.sourceDirs.size;
    const watchErrors: string[] = [];

    for (const [sourceType, dirs] of config.sourceDirs.entries()) {
      for (const dir of dirs) {
        try {
          // Check directory exists
          await fs.access(dir);

          const watcher = chokidar.watch(dir, {
            ignoreInitial: true,
            // Agent roots contain agent/<database> and sessions/<archive> two levels below.
            depth: sourceType === 'openclaw' ? 2 : 0,
            awaitWriteFinish: {
              stabilityThreshold: 300,
              pollInterval: 100,
            },
          });

          watcher.on('add', (filePath: string) => registerPath(sourceType, filePath));
          watcher.on('change', (filePath: string) => registerPath(sourceType, filePath));
          watcher.on('unlink', (filePath: string) => registerPath(sourceType, filePath));

          watcher.on('error', (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            status.lastError = `Chokidar error on ${dir}: ${msg}`;
            logger.error(`[watcher] Chokidar error: ${dir}:`, msg);
          });

          watcher.on('ready', () => {
            const filesWatched = (watcher as any)._watched ? Object.keys((watcher as any)._watched).length : 0;
            status.filesWatched += filesWatched;
            logger.debug(`[watcher] Ready on ${dir} — watching ${filesWatched} files`);
          });

          chokidarWatchers.set(`${sourceType}:${dir}`, watcher);
          logger.debug(`[watcher] Watching ${sourceType}: ${dir}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          watchErrors.push(`${sourceType}:${dir}: ${msg}`);
          logger.warn(`[watcher] Cannot watch ${dir}: ${msg}`);
        }
      }
    }

    if (watchErrors.length > 0) {
      status.lastError = watchErrors.join('; ');
      logger.warn(`[watcher] ${watchErrors.length} directories could not be watched`);
    }

    // Start periodic resync
    resyncInterval = setInterval(runPeriodicResync, config.resyncIntervalMs);

    status.running = true;
    logger.info('[watcher] Watcher started');
  }

  // ==========================================================================
  // Lifecycle: stop()
  // ==========================================================================

  async function stop(): Promise<void> {
    if (!status.running) {
      return;
    }

    // Clear debounce timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    // Clear resync interval
    if (resyncInterval) {
      clearInterval(resyncInterval);
      resyncInterval = null;
    }

    // Close all chokidar watchers
    const closePromises: Promise<void>[] = [];
    for (const [key, watcher] of chokidarWatchers.entries()) {
      closePromises.push(watcher.close());
    }
    await Promise.allSettled(closePromises);
    chokidarWatchers.clear();

    // Reset state
    pendingPaths.clear();
    status.running = false;
    status.filesWatched = 0;
    status.sourceCount = 0;

    logger.info('[watcher] Watcher stopped');
  }

  // ==========================================================================
  // Status
  // ==========================================================================

  function getStatus(): WatcherStatus {
    return { ...status };
  }

  return { start, stop, getStatus };
}
