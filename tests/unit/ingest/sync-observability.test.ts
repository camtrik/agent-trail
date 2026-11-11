import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncScheduler } from '@/ingest/src/sync-scheduler';
import type { SyncResult } from '@/ingest/sync';

function result(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    sessionsInserted: 1,
    sessionsUpdated: 2,
    messagesInserted: 3,
    toolCallsInserted: 4,
    toolResultEventsInserted: 5,
    errors: [],
    metrics: {
      filesConsidered: 6,
      filesSkippedBeforeParse: 1,
      filesParsed: 5,
      filesParsedFully: 2,
      filesParsedIncrementally: 3,
      incrementalFallbacks: 1,
      largestFileBytes: 4096,
    },
    ...overrides,
  };
}

describe('sync observability', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_TRAIL_LOG_LEVEL', 'debug');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('emits exactly one structured completion log for a successful run', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const scheduler = createSyncScheduler({
      syncSource: vi.fn().mockResolvedValue(result()),
      syncPaths: vi.fn(),
    });

    await scheduler.enqueueFullSource('codex', 'manual');

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0][0]));
    expect(payload).toMatchObject({
      event: 'ingest_sync_complete',
      reason: 'manual',
      scope: 'full:codex',
      filesConsidered: 6,
      filesParsed: 5,
      errorCount: 0,
    });
    expect(typeof payload.durationMs).toBe('number');
  });

  it('emits exactly one structured completion log for a failed run', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const scheduler = createSyncScheduler({
      syncSource: vi.fn().mockRejectedValue(new Error('boom')),
      syncPaths: vi.fn(),
    });

    await expect(scheduler.enqueueFullSource('codex', 'manual')).rejects.toThrow('boom');

    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(log.mock.calls[0][0]));
    expect(payload.reason).toBe('manual');
    expect(payload.scope).toBe('full:codex');
    expect(payload.errorCount).toBe(1);
  });

  it('exposes write counts and largest file bytes without raw content', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const scheduler = createSyncScheduler({
      syncSource: vi.fn().mockResolvedValue(result()),
      syncPaths: vi.fn(),
    });

    await scheduler.enqueueFullSource('codex', 'background');
    const debug = scheduler.getDebugStatus();
    const serialized = JSON.stringify(debug);

    expect(debug.metrics.messagesWritten).toBe(3);
    expect(debug.metrics.toolCallsWritten).toBe(4);
    expect(debug.metrics.resultEventsWritten).toBe(5);
    expect(debug.metrics.largestFileBytes).toBe(4096);
    expect(serialized).not.toContain('message content');
    expect(serialized).not.toContain('raw');
  });
});
