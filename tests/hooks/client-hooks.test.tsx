// @vitest-environment jsdom

/**
 * Tests for client hooks exported from lib/agent-tools/client-hooks.tsx.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'

import {
  clearToolApiCacheForTests,
  SESSION_REFRESH_EVENT,
  notifySessionsRefresh,
  syncAllSessions,
  syncToolSessions,
  useAggregateSessions,
  useIngestLiveUpdates,
  useIngestStatus,
  useOverviewAggregates,
  useSSE,
  useSessionTurns,
  useToolSessions,
} from '@/lib/agent-tools/client-hooks'
import type { TraceSession, TraceTurn } from '@/types/trace'

const fetchMock = vi.fn()

beforeEach(() => {
  clearToolApiCacheForTests()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      sessions: [],
      pagination: { total: 0, limit: 50, offset: 0, hasMore: false },
    }),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  clearToolApiCacheForTests()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useSSE', () => {
  it('is an exported function from client-hooks', () => {
    expect(typeof useSSE).toBe('function')
  })

  it('has the expected signature (toolId param required, sessionId + onEvent optional)', () => {
    // Verify the function accepts the right arity
    expect(useSSE.length).toBeGreaterThanOrEqual(1)
  })
})

type MockEventListener = (event: MessageEvent) => void

class MockEventSource {
  static instances: MockEventSource[] = []

  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  listeners = new Map<string, MockEventListener[]>()
  closed = false

  constructor(public url: string) {
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: MockEventListener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close() {
    this.closed = true
  }

  emit(type: string, data: Record<string, unknown>) {
    const event = { data: JSON.stringify(data) } as MessageEvent
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe('useIngestLiveUpdates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dispatches a coalesced refresh for matching SSE events and refreshes indexing status', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_REFRESH_EVENT, listener)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'ok',
        ready: false,
        sync: {
          phase: 'indexing',
          currentSource: 'codex',
          scheduler: { active: true, activeSourceType: 'codex' },
        },
      }),
    })

    let latest: ReturnType<typeof useIngestLiveUpdates> | undefined
    function Consumer() {
      latest = useIngestLiveUpdates('codex')
      return null
    }

    render(<Consumer />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/agent-tools/codex/health')
    expect(latest?.indexing).toBe(true)
    expect(latest?.currentSource).toBe('codex')
    expect(MockEventSource.instances[0]?.url).toBe('/api/agent-tools/codex/events')

    act(() => {
      MockEventSource.instances[0].emit('session_updated', { source: 'codex', sessionId: 's1' })
      vi.advanceTimersByTime(349)
    })
    expect(listener).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1)
    })

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(SESSION_REFRESH_EVENT, listener)
  })

  it('ignores source-specific SSE events from another source', async () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_REFRESH_EVENT, listener)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', ready: true, sync: { phase: 'idle' } }),
    })

    function Consumer() {
      useIngestLiveUpdates('codex')
      return null
    }

    render(<Consumer />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(MockEventSource.instances).toHaveLength(1)

    act(() => {
      MockEventSource.instances[0].emit('session_updated', { source: 'openclaw', sessionId: 's1' })
      vi.advanceTimersByTime(350)
    })

    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(SESSION_REFRESH_EVENT, listener)
  })
})

describe('useIngestStatus', () => {
  it('is an exported function from client-hooks', () => {
    expect(typeof useIngestStatus).toBe('function')
  })

  it('has the expected signature (toolId param required)', () => {
    expect(useIngestStatus.length).toBeGreaterThanOrEqual(1)
  })
})

describe('session refresh event', () => {
  it('refetches tool sessions when the global refresh event is dispatched', async () => {
    function Consumer() {
      useToolSessions('codex', { limit: '40', sort: 'updated_at', order: 'desc' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new Event(SESSION_REFRESH_EVENT))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('dispatches the documented session refresh event name', () => {
    const listener = vi.fn()
    window.addEventListener(SESSION_REFRESH_EVENT, listener)

    notifySessionsRefresh()

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(SESSION_REFRESH_EVENT, listener)
  })

  it('refetches cached overview data when the global refresh event is dispatched', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ totalSessions: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ totalSessions: 2 }),
      })

    let latest: ReturnType<typeof useOverviewAggregates> | undefined
    function Consumer() {
      latest = useOverviewAggregates('codex', '30d')
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.loading).toBe(false))
    expect(latest?.aggregates).toEqual({ totalSessions: 1 })

    notifySessionsRefresh()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(latest?.aggregates).toEqual({ totalSessions: 2 })
  })
})

// ============================================================================
// Ingest indexing state (504 → indexing + auto-retry, distinct from 502)
// ============================================================================

function statusResponse(status: number, body: unknown) {
  return { ok: false, status, json: async () => body }
}

function okSessionsResponse(sessions: TraceSession[]) {
  return {
    ok: true,
    json: async () => ({
      sessions,
      pagination: { total: sessions.length, limit: 100, offset: 0, hasMore: false },
    }),
  }
}

describe('ingest indexing state', () => {
  it('surfaces an indexing state (not an error) when a tool fetch returns 504', async () => {
    fetchMock.mockResolvedValue(
      statusResponse(504, { error: 'Ingest service is still indexing. Retry shortly.' }),
    )

    let latest: ReturnType<typeof useToolSessions> | undefined
    function Consumer() {
      latest = useToolSessions('codex', { limit: '40', sort: 'updated_at', order: 'desc' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.indexing).toBe(true))
    expect(latest?.error).toBeNull()
  })

  it('clears the indexing state once a later tool fetch succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(statusResponse(504, { error: 'Ingest service is still indexing.' }))
      .mockResolvedValue(
        okSessionsResponse([
          sessionFixture('s1', 'codex', { startedAt: '2026-05-10T00:00:00.000Z' }),
        ]),
      )

    let latest: ReturnType<typeof useToolSessions> | undefined
    function Consumer() {
      latest = useToolSessions('codex', { limit: '40', sort: 'updated_at', order: 'desc' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.indexing).toBe(true))

    act(() => notifySessionsRefresh())

    await waitFor(() => expect(latest?.indexing).toBe(false))
    expect(latest?.sessions).toHaveLength(1)
    expect(latest?.error).toBeNull()
  })

  it('surfaces a hard error (not indexing) when a tool fetch returns 502', async () => {
    fetchMock.mockResolvedValue(
      statusResponse(502, { error: 'Ingest service unreachable' }),
    )

    let latest: ReturnType<typeof useToolSessions> | undefined
    function Consumer() {
      latest = useToolSessions('codex', { limit: '40', sort: 'updated_at', order: 'desc' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.error).toBe('Ingest service unreachable'))
    expect(latest?.indexing).toBe(false)
  })

  it('surfaces indexing (not the unreachable error) when every aggregate source returns 504', async () => {
    fetchMock.mockResolvedValue(
      statusResponse(504, { error: 'Ingest service is still indexing.' }),
    )

    let latest: AggregateHookResult | undefined
    function Consumer() {
      latest = useAggregateSessions({ limit: '100' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.indexing).toBe(true))
    expect(latest?.error).toBeNull()
  })

  it('surfaces the aggregate unreachable error (not indexing) when every source returns 502', async () => {
    fetchMock.mockResolvedValue(
      statusResponse(502, { error: 'Ingest service unreachable' }),
    )

    let latest: AggregateHookResult | undefined
    function Consumer() {
      latest = useAggregateSessions({ limit: '100' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.error).toBe('All ingest sources unreachable'))
    expect(latest?.indexing).toBe(false)
  })
})

// ============================================================================
// useAggregateSessions
// ============================================================================

function sessionFixture(
  id: string,
  source: TraceSession['source'],
  timestamps: {
    startedAt: string
    endedAt?: string | null
    updatedAt?: string | null
  },
): TraceSession {
  return {
    id,
    source,
    project: 'project',
    name: id,
    startedAt: timestamps.startedAt,
    endedAt: timestamps.endedAt ?? null,
    updatedAt: timestamps.updatedAt ?? undefined,
    status: 'idle',
    metrics: {
      messageCount: 1,
      userMessageCount: 1,
      hasToolCalls: false,
      parserMalformedLines: 0,
      isTruncated: false,
    },
    turns: [],
  }
}

type AggregateHookResult = ReturnType<typeof useAggregateSessions>
type SessionTurnsHookResult = ReturnType<typeof useSessionTurns>

describe('useAggregateSessions', () => {
  it('fetches initial aggregate sessions through the six BFF source URLs', async () => {
    let latest: AggregateHookResult | undefined

    function Consumer() {
      latest = useAggregateSessions({ limit: '100' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.loading).toBe(false))

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls).toHaveLength(6)
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/api\/agent-tools\/openclaw\/sessions\?/),
        expect.stringMatching(/^\/api\/agent-tools\/claude-code\/sessions\?/),
        expect.stringMatching(/^\/api\/agent-tools\/codex\/sessions\?/),
        expect.stringMatching(/^\/api\/agent-tools\/opencode\/sessions\?/),
        expect.stringMatching(/^\/api\/agent-tools\/qoder\/sessions\?/),
      ]),
    )
    expect(urls.join('\n')).not.toMatch(/localhost:8078|127\.0\.0\.1|\/api\/v1/)
  })

  it('reuses aggregate source cache when switching from all sessions to one source', async () => {
    const railQuery = { limit: '100', sort: 'updated_at', order: 'desc' }
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [sessionFixture('openclaw-1', 'openclaw', { startedAt: '2026-05-10T00:00:00.000Z' })],
          pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [sessionFixture('claude-1', 'claude-code', { startedAt: '2026-05-10T00:01:00.000Z' })],
          pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [sessionFixture('codex-1', 'codex', { startedAt: '2026-05-10T00:02:00.000Z' })],
          pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
        }),
      })

    let aggregateLatest: AggregateHookResult | undefined
    function AggregateConsumer() {
      aggregateLatest = useAggregateSessions(railQuery)
      return null
    }

    render(<AggregateConsumer />)
    await waitFor(() => expect(aggregateLatest?.loading).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(6)

    cleanup()
    fetchMock.mockClear()

    let sourceLatest: ReturnType<typeof useToolSessions> | undefined
    function SourceConsumer() {
      sourceLatest = useToolSessions('claude-code', railQuery)
      return null
    }

    render(<SourceConsumer />)

    expect(sourceLatest?.loading).toBe(false)
    expect(sourceLatest?.sessions.map((session) => session.id)).toEqual(['claude-1'])

    await act(async () => {})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses source pagination totals for aggregate totalCount', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [sessionFixture('openclaw-1', 'openclaw', { startedAt: '2026-05-10T00:00:00.000Z' })],
          pagination: { total: 10, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [sessionFixture('claude-1', 'claude-code', { startedAt: '2026-05-10T00:01:00.000Z' })],
          pagination: { total: 20, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [sessionFixture('codex-1', 'codex', { startedAt: '2026-05-10T00:02:00.000Z' })],
          pagination: { total: 30, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
        }),
      })

    let latest: AggregateHookResult | undefined

    function Consumer() {
      latest = useAggregateSessions({ limit: '100' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.loading).toBe(false))

    expect(latest?.sessions).toHaveLength(3)
    expect(latest?.totalCount).toBe(60)
  })

  it('reports hasMore when any source has another page', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 101, limit: 100, offset: 0, hasMore: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
        }),
      })

    let latest: AggregateHookResult | undefined

    function Consumer() {
      latest = useAggregateSessions({ limit: '100' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.loading).toBe(false))

    expect(latest?.hasMore).toBe(true)
    expect(latest?.paginationBySource.openclaw?.hasMore).toBe(true)
  })

  it('loads only sources with more pages, dedupes by session id, and sorts by freshness', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            sessionFixture('shared', 'openclaw', { startedAt: '2026-05-10T00:00:00.000Z' }),
            sessionFixture('old-openclaw', 'openclaw', { startedAt: '2026-05-10T00:01:00.000Z' }),
          ],
          pagination: { total: 4, limit: 2, offset: 0, hasMore: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            sessionFixture('claude-only', 'claude-code', {
              startedAt: '2026-05-10T00:02:00.000Z',
              endedAt: '2026-05-10T00:03:00.000Z',
            }),
          ],
          pagination: { total: 1, limit: 2, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            sessionFixture('codex-old', 'codex', { startedAt: '2026-05-10T00:04:00.000Z' }),
          ],
          pagination: { total: 3, limit: 1, offset: 0, hasMore: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 0, limit: 2, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [],
          pagination: { total: 0, limit: 2, offset: 0, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [], pagination: { total: 0, limit: 2, offset: 0, hasMore: false } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            sessionFixture('openclaw-new', 'openclaw', {
              startedAt: '2026-05-10T00:05:00.000Z',
              updatedAt: '2026-05-10T00:20:00.000Z',
            }),
            sessionFixture('shared', 'openclaw', {
              startedAt: '2026-05-10T00:06:00.000Z',
              updatedAt: '2026-05-10T00:30:00.000Z',
            }),
          ],
          pagination: { total: 4, limit: 2, offset: 2, hasMore: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [
            sessionFixture('codex-new', 'codex', {
              startedAt: '2026-05-10T00:07:00.000Z',
              endedAt: '2026-05-10T00:25:00.000Z',
            }),
          ],
          pagination: { total: 3, limit: 1, offset: 1, hasMore: true },
        }),
      })

    let latest: AggregateHookResult | undefined

    function Consumer() {
      latest = useAggregateSessions({ limit: '100' })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.loading).toBe(false))

    await act(async () => {
      await latest?.loadMore()
    })

    await waitFor(() => expect(latest?.isLoadingMore).toBe(false))

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    const nextPageUrls = urls.slice(6)
    expect(nextPageUrls).toHaveLength(2)
    expect(nextPageUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/api/agent-tools/openclaw/sessions?'),
        expect.stringContaining('/api/agent-tools/codex/sessions?'),
      ]),
    )
    expect(nextPageUrls).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining('/api/agent-tools/claude-code/sessions?'),
        expect.stringContaining('/api/agent-tools/opencode/sessions?'),
        expect.stringContaining('/api/agent-tools/qoder/sessions?'),
      ]),
    )
    expect(nextPageUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('offset=2'),
        expect.stringContaining('offset=1'),
      ]),
    )

    expect(latest?.totalCount).toBe(8)
    expect(latest?.hasMore).toBe(true)
    expect(latest?.sessions.map((session) => session.id)).toEqual([
      'shared',
      'codex-new',
      'openclaw-new',
      'codex-old',
      'claude-only',
      'old-openclaw',
    ])
  })
})

// ============================================================================
// useSessionTurns
// ============================================================================

function turnFixture(id: string, index: number): TraceTurn {
  return {
    id,
    sessionId: 'session-1',
    index,
    userMessage: null,
    assistantMessages: [],
    activities: [],
    startedAt: null,
    endedAt: null,
    durationMs: null,
  }
}

describe('useSessionTurns', () => {
  it('loads more turns through BFF pagination and appends without duplicates', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          turns: [turnFixture('turn-1', 0)],
          pagination: { total: 2, limit: 1, offset: 0, hasMore: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          turns: [turnFixture('turn-1', 0), turnFixture('turn-2', 1)],
          pagination: { total: 2, limit: 1, offset: 1, hasMore: false },
        }),
      })

    let latest: SessionTurnsHookResult | undefined

    function Consumer() {
      latest = useSessionTurns('codex', 'session-1', { limit: 1 })
      return null
    }

    render(<Consumer />)

    await waitFor(() => expect(latest?.loading).toBe(false))

    await act(async () => {
      await latest?.loadMore()
    })

    await waitFor(() => expect(latest?.isLoadingMore).toBe(false))

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls).toHaveLength(2)
    expect(urls[0]).toMatch(/^\/api\/agent-tools\/codex\/sessions\/session-1\/turns\?/)
    expect(urls[0]).toContain('limit=1')
    expect(urls[1]).toContain('/api/agent-tools/codex/sessions/session-1/turns?')
    expect(urls[1]).toContain('offset=1')
    expect(urls[1]).toContain('limit=1')
    expect(latest?.turns.map((turn) => turn.id)).toEqual(['turn-1', 'turn-2'])
    expect(latest?.pagination?.hasMore).toBe(false)
  })
})

// ============================================================================
// syncToolSessions
// ============================================================================

describe('syncToolSessions', () => {
  it('calls /api/agent-tools/codex/sync before session refetch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ type: 'codex', syncResult: {}, status: 'completed' }),
    })

    await syncToolSessions('codex')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/agent-tools/codex/sync')
    expect(opts.method).toBe('POST')
  })

  it('appends ?force=true when force option is set', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ type: 'codex', syncResult: {}, status: 'completed' }),
    })

    await syncToolSessions('codex', { force: true })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('force=true')
  })

  it('does not append force param when force is false', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ type: 'codex', syncResult: {}, status: 'completed' }),
    })

    await syncToolSessions('codex', { force: false })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).not.toContain('force')
  })

  it('throws on non-ok response and does not call sessions endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Unsupported source type' }),
    })

    await expect(syncToolSessions('all')).rejects.toThrow('Unsupported source type')
    // Only one fetch call was made (the sync one) — no sessions refetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves session list state when sync fails (error thrown, caller responsible)', async () => {
    // When sync throws, the caller (SessionsRightRail) catches it and still
    // calls refetch() to preserve the current list. This test verifies the
    // error propagation contract.
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: 'Ingest service unreachable' }),
    })

    let caughtError: Error | null = null
    try {
      await syncToolSessions('claude-code')
    } catch (err) {
      caughtError = err as Error
    }

    expect(caughtError).not.toBeNull()
    expect(caughtError?.message).toBe('Ingest service unreachable')
  })
})

// ============================================================================
// syncAllSessions
// ============================================================================

describe('syncAllSessions', () => {
  it('calls /api/sync before aggregate refetch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], force: false }),
    })

    await syncAllSessions()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sync')
    expect(opts.method).toBe('POST')
  })

  it('appends ?force=true when force option is set', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [], force: true }),
    })

    await syncAllSessions({ force: true })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain('force=true')
  })

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Aggregate sync failed: 500' }),
    })

    await expect(syncAllSessions()).rejects.toThrow()
  })
})
