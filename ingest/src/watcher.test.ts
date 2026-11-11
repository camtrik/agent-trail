/**
 * Watcher Service Tests
 *
 * Tests the chokidar-based file watcher with debounce, periodic resync,
 * temp file filtering, error handling, and lifecycle management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Module under test
import { createWatcher, WatcherConfig, WatcherStatus } from './watcher';

// ============================================================================
// Helpers
// ============================================================================

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-test-'));
});

afterEach(async () => {
  try { await fs.rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function createFile(filePath: string, content = '{"type":"test"}\n') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function buildConfig(overrides?: Partial<WatcherConfig>): WatcherConfig {
  return {
    sourceDirs: new Map([['openclaw', [tempDir]]]),
    debounceMs: 100, // Short debounce for tests
    resyncIntervalMs: 60000, // Long interval to avoid firing during tests
    fileExtensions: ['.jsonl', '.json', '.md'],
    onPathsChanged: vi.fn(),
    onFullResync: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// Test 1: Watcher creation and lifecycle
// ============================================================================

describe('createWatcher()', () => {
  it('returns an object with start(), stop(), and getStatus() methods', () => {
    const watcher = createWatcher(buildConfig());
    expect(watcher).toBeDefined();
    expect(typeof watcher.start).toBe('function');
    expect(typeof watcher.stop).toBe('function');
    expect(typeof watcher.getStatus).toBe('function');
  });

  it('getStatus() returns default status before start()', () => {
    const watcher = createWatcher(buildConfig());
    const status: WatcherStatus = watcher.getStatus();
    expect(status.running).toBe(false);
    expect(status.filesWatched).toBe(0);
    expect(status.lastSyncAt).toBeNull();
    expect(status.lastError).toBeNull();
    expect(status.sourceCount).toBe(0);
  });
});

// ============================================================================
// Test 2: Watcher start() watches configured source directories
// ============================================================================

describe('watcher.start()', () => {
  it('sets running to true after start', async () => {
    const watcher = createWatcher(buildConfig());
    await watcher.start();
    expect(watcher.getStatus().running).toBe(true);
    await watcher.stop();
  });

  it('watches source directories with chokidar for file changes', async () => {
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({
      onPathsChanged: onSync,
      debounceMs: 200,
    }));
    await watcher.start();

    // Give chokidar a moment to set up
    await new Promise((r) => setTimeout(r, 500));

    // Create a .jsonl file in the watched directory
    await createFile(path.join(tempDir, 'session1.jsonl'), '{"role":"user","content":"hello"}\n');

    // Wait for chokidar awaitWriteFinish (300ms) + debounce (200ms) + buffer
    await new Promise((r) => setTimeout(r, 800));

    expect(onSync).toHaveBeenCalledWith('openclaw', [path.join(tempDir, 'session1.jsonl')]);
    await watcher.stop();
  }, 15000);

  it('discovers new nested OpenClaw databases and coalesces their WAL sidecars', async () => {
    const onPathsChanged = vi.fn();
    const watcher = createWatcher(buildConfig({ onPathsChanged, debounceMs: 100 }));
    try {
      await watcher.start();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const dbPath = path.join(tempDir, 'new-agent', 'agent', 'openclaw-agent.sqlite');
      await createFile(dbPath, 'database');
      await createFile(dbPath + '-wal', 'wal');
      await vi.waitFor(() => {
        expect(onPathsChanged).toHaveBeenCalledWith('openclaw', [dbPath]);
      }, { timeout: 4000, interval: 50 });
      expect(onPathsChanged).toHaveBeenCalledTimes(1);
    } finally {
      await watcher.stop();
    }
  }, 10000);

  it('watches .json and .md files as well as .jsonl', async () => {
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({
      onPathsChanged: onSync,
      debounceMs: 200,
      fileExtensions: ['.jsonl', '.json', '.md'],
    }));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    await createFile(path.join(tempDir, 'session1.md'), '# Test\n');

    await new Promise((r) => setTimeout(r, 800));
    expect(onSync).toHaveBeenCalledWith('openclaw', [path.join(tempDir, 'session1.md')]);
    await watcher.stop();
  }, 15000);
});

// ============================================================================
// Test 3: Debounce — rapid changes within debounceMs batch into one sync
// ============================================================================

describe('debounce behavior', () => {
  it('batches rapid file changes within debounce window into a single sync trigger', async () => {
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({
      onPathsChanged: onSync,
      debounceMs: 500,
    }));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    // Rapidly create 3 files
    await createFile(path.join(tempDir, 'a.jsonl'), '{"a":1}\n');
    await createFile(path.join(tempDir, 'b.jsonl'), '{"b":2}\n');
    await createFile(path.join(tempDir, 'c.jsonl'), '{"c":3}\n');

    // Wait for chokidar stabilization + debounce window
    await new Promise((r) => setTimeout(r, 1200));

    // Should be called exactly once for this batch (all same source type)
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(onSync).toHaveBeenCalledWith('openclaw', [
      path.join(tempDir, 'a.jsonl'),
      path.join(tempDir, 'b.jsonl'),
      path.join(tempDir, 'c.jsonl'),
    ]);
    await watcher.stop();
  }, 20000);
});

// ============================================================================
// Test 4: Temp file filtering
// ============================================================================

describe('temp file filtering', () => {
  it('filters out editor swap files ending in ~', async () => {
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({ onPathsChanged: onSync, debounceMs: 200 }));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    await createFile(path.join(tempDir, 'session1.jsonl~'), '{}');

    // Wait longer than debounce window
    await new Promise((r) => setTimeout(r, 800));
    expect(onSync).not.toHaveBeenCalled();
    await watcher.stop();
  }, 15000);

  it('filters out .DS_Store files', async () => {
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({ onPathsChanged: onSync, debounceMs: 200 }));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    await createFile(path.join(tempDir, '.DS_Store'), '');

    await new Promise((r) => setTimeout(r, 800));
    expect(onSync).not.toHaveBeenCalled();
    await watcher.stop();
  }, 15000);

  it('filters out .swp files', async () => {
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({ onPathsChanged: onSync, debounceMs: 200 }));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    await createFile(path.join(tempDir, 'session1.swp'), '');

    await new Promise((r) => setTimeout(r, 800));
    expect(onSync).not.toHaveBeenCalled();
    await watcher.stop();
  }, 15000);

  it('allows valid .jsonl files through', async () => {
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({
      onPathsChanged: onSync,
      debounceMs: 200,
    }));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));

    await createFile(path.join(tempDir, 'valid.jsonl'), '{"test":1}\n');

    await vi.waitFor(() => {
      expect(onSync).toHaveBeenCalledWith('openclaw', [path.join(tempDir, 'valid.jsonl')]);
    }, { timeout: 4000, interval: 50 });
    await watcher.stop();
  }, 15000);
});

// ============================================================================
// Test 5: Graceful error handling
// ============================================================================

describe('error handling', () => {
  it('watcher.start() handles missing directories gracefully', async () => {
    const missingDir = path.join(tempDir, 'nonexistent');
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({
      sourceDirs: new Map([['openclaw', [missingDir]]]),
      onPathsChanged: onSync,
    }));
    // Should not throw
    await watcher.start();
    await new Promise((r) => setTimeout(r, 300));
    const status = watcher.getStatus();
    expect(status.filesWatched).toBe(0);
    await watcher.stop();
  }, 10000);

  it('watcher stop() is idempotent (safe to call twice)', async () => {
    const watcher = createWatcher(buildConfig());
    await watcher.start();
    await watcher.stop();
    // Second stop should not throw
    await watcher.stop();
    expect(watcher.getStatus().running).toBe(false);
  });
});

// ============================================================================
// Test 6: Periodic resync
// ============================================================================

describe('periodic resync', () => {
  it('periodic resync callback fires with source types at configured interval', async () => {
    vi.useFakeTimers();
    const onSync = vi.fn();
    const watcher = createWatcher(buildConfig({
      onFullResync: onSync,
      resyncIntervalMs: 300000, // 5 min
      debounceMs: 500,
    }));
    await watcher.start();

    // Advance time past one resync interval
    vi.advanceTimersByTime(300001);

    // onSyncTrigger should be called for each source type
    expect(onSync).toHaveBeenCalledWith('openclaw');
    vi.useRealTimers();
    await watcher.stop();
  });

  it('periodic resync does not crash if onSyncTrigger throws synchronously', async () => {
    vi.useFakeTimers();
    const watcher = createWatcher(buildConfig({
      onFullResync: () => { throw new Error('test error'); },
      resyncIntervalMs: 300000,
    }));
    await watcher.start();

    // Should not throw
    vi.advanceTimersByTime(300001);
    expect(watcher.getStatus().lastError).toBe('test error');
    vi.useRealTimers();
    await watcher.stop();
  });
});

// ============================================================================
// Test 7: WatcherStatus sourceCount
// ============================================================================

describe('WatcherStatus', () => {
  it('reports sourceCount matching the number of source types', async () => {
    const watcher = createWatcher(buildConfig({
      sourceDirs: new Map([
        ['openclaw', [tempDir]],
        ['claude-code', [tempDir]],
      ]),
    }));
    await watcher.start();
    const status = watcher.getStatus();
    expect(status.sourceCount).toBe(2);
    await watcher.stop();
  });
});

// ============================================================================
// Test 8: start() idempotency
// ============================================================================

describe('start idempotency', () => {
  it('starting an already running watcher does not crash', async () => {
    const watcher = createWatcher(buildConfig({ debounceMs: 500 }));
    await watcher.start();
    await watcher.start(); // double start
    expect(watcher.getStatus().running).toBe(true);
    await watcher.stop();
  });
});
