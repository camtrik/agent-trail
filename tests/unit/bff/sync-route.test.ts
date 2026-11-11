/**
 * Tests for BFF sync routes:
 *   - app/api/agent-tools/[tool]/sync/route.ts (per-source)
 *   - app/api/sync/route.ts (aggregate)
 *
 * These tests exercise route-level validation, force forwarding, and
 * error sanitization without an actual ingest service running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock fetchIngest so tests don't need the ingest service running
// ---------------------------------------------------------------------------

const fetchIngestMock = vi.fn()

vi.mock('@/lib/agent-tools/server-adapter', () => ({
  fetchIngest: (...args: unknown[]) => fetchIngestMock(...args),
  sanitizeError: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith('Invalid source tool ID')) {
      return { error: err.message, code: 400 }
    }
    return { error: 'Ingest service unreachable', code: 502 }
  },
}))

// ---------------------------------------------------------------------------
// Helper: build a plain Request for route handlers
// ---------------------------------------------------------------------------

function makeRequest(url: string, opts?: { body?: unknown }): Request {
  return new Request(url, {
    method: 'POST',
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ---------------------------------------------------------------------------
// Per-source BFF sync route
// ---------------------------------------------------------------------------

describe('app/api/agent-tools/[tool]/sync/route.ts', () => {
  const SYNC_RESULT = {
    type: 'codex',
    syncResult: {
      sessionsInserted: 1,
      sessionsUpdated: 0,
      messagesInserted: 3,
      errors: [],
    },
    status: 'completed',
  }

  beforeEach(() => {
    fetchIngestMock.mockResolvedValue(SYNC_RESULT)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls /api/v1/sources/:type/sync for a valid tool', async () => {
    const { POST } = await import('@/app/api/agent-tools/[tool]/sync/route')

    const req = makeRequest('http://localhost/api/agent-tools/codex/sync')
    await POST(req, { params: Promise.resolve({ tool: 'codex' }) })

    expect(fetchIngestMock).toHaveBeenCalledTimes(1)
    const [path] = fetchIngestMock.mock.calls[0] as [string]
    expect(path).toBe('/api/v1/sources/codex/sync')
  })

  it('returns 200 with sync result on success', async () => {
    const { POST } = await import('@/app/api/agent-tools/[tool]/sync/route')

    const req = makeRequest('http://localhost/api/agent-tools/codex/sync')
    const res = await POST(req, { params: Promise.resolve({ tool: 'codex' }) })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('syncResult')
    expect(body).toHaveProperty('status', 'completed')
  })

  it('forwards force=true via query param to ingest', async () => {
    const { POST } = await import('@/app/api/agent-tools/[tool]/sync/route')

    const req = makeRequest('http://localhost/api/agent-tools/claude-code/sync?force=true')
    await POST(req, { params: Promise.resolve({ tool: 'claude-code' }) })

    expect(fetchIngestMock).toHaveBeenCalledTimes(1)
    const [, opts] = fetchIngestMock.mock.calls[0] as [string, { body?: { force?: boolean } }]
    expect(opts?.body).toMatchObject({ force: true })
  })

  it('does not include force in body when not requested', async () => {
    const { POST } = await import('@/app/api/agent-tools/[tool]/sync/route')

    const req = makeRequest('http://localhost/api/agent-tools/openclaw/sync')
    await POST(req, { params: Promise.resolve({ tool: 'openclaw' }) })

    expect(fetchIngestMock).toHaveBeenCalledTimes(1)
    const [, opts] = fetchIngestMock.mock.calls[0] as [string, { body?: unknown }]
    // body should be undefined (no force flag)
    expect(opts?.body).toBeUndefined()
  })

  it('returns 400 for invalid tool ID "all"', async () => {
    const { POST } = await import('@/app/api/agent-tools/[tool]/sync/route')

    const req = makeRequest('http://localhost/api/agent-tools/all/sync')
    const res = await POST(req, { params: Promise.resolve({ tool: 'all' }) })

    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
    expect(body.error).toContain('all')
  })

  it('returns 400 for unknown tool ID', async () => {
    const { POST } = await import('@/app/api/agent-tools/[tool]/sync/route')

    const req = makeRequest('http://localhost/api/agent-tools/unknown/sync')
    const res = await POST(req, { params: Promise.resolve({ tool: 'unknown' }) })

    expect(res.status).toBe(400)
  })

  it('returns sanitized error when ingest fetch fails', async () => {
    fetchIngestMock.mockRejectedValueOnce(new Error('connection refused'))
    const { POST } = await import('@/app/api/agent-tools/[tool]/sync/route')

    const req = makeRequest('http://localhost/api/agent-tools/codex/sync')
    const res = await POST(req, { params: Promise.resolve({ tool: 'codex' }) })

    expect(res.status).toBe(502)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
    // Must not expose internal error message to client
    expect(body.error).not.toContain('connection refused')
  })
})

// ---------------------------------------------------------------------------
// Aggregate BFF sync route
// ---------------------------------------------------------------------------

describe('app/api/sync/route.ts', () => {
  beforeEach(() => {
    fetchIngestMock.mockResolvedValue({
      type: 'openclaw',
      syncResult: { sessionsInserted: 0, sessionsUpdated: 0, messagesInserted: 0, errors: [] },
      status: 'completed',
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('calls ingest sync for all 6 source types', async () => {
    const { POST } = await import('@/app/api/sync/route')

    const req = makeRequest('http://localhost/api/sync')
    await POST(req)

    expect(fetchIngestMock).toHaveBeenCalledTimes(6)
    const paths = fetchIngestMock.mock.calls.map((call) => call[0] as string)
    expect(paths).toContain('/api/v1/sources/openclaw/sync')
    expect(paths).toContain('/api/v1/sources/claude-code/sync')
    expect(paths).toContain('/api/v1/sources/codex/sync')
    expect(paths).toContain('/api/v1/sources/commandcode/sync')
    expect(paths).toContain('/api/v1/sources/opencode/sync')
    expect(paths).toContain('/api/v1/sources/qoder/sync')
  })

  it('forwards force=true to all source syncs when query param is set', async () => {
    const { POST } = await import('@/app/api/sync/route')

    const req = makeRequest('http://localhost/api/sync?force=true')
    await POST(req)

    expect(fetchIngestMock).toHaveBeenCalledTimes(6)
    for (const call of fetchIngestMock.mock.calls) {
      const [, opts] = call as [string, { body?: { force?: boolean } }]
      expect(opts?.body).toMatchObject({ force: true })
    }
  })

  it('returns per-source results array', async () => {
    const { POST } = await import('@/app/api/sync/route')

    const req = makeRequest('http://localhost/api/sync')
    const res = await POST(req)

    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.results)).toBe(true)
    expect((body.results as unknown[]).length).toBe(6)
  })

  it('includes per-source error when one source sync fails, overall response is 200', async () => {
    // First call succeeds, second fails (sanitizeError mock returns code 502), third+fourth+fifth succeed
    fetchIngestMock
      .mockResolvedValueOnce({ type: 'openclaw', syncResult: {}, status: 'completed' })
      .mockRejectedValueOnce(new Error('ingest down'))
      .mockResolvedValueOnce({ type: 'codex', syncResult: {}, status: 'completed' })
      .mockResolvedValueOnce({ type: 'opencode', syncResult: {}, status: 'completed' })
      .mockResolvedValueOnce({ type: 'qoder', syncResult: {}, status: 'completed' })

    const { POST } = await import('@/app/api/sync/route')

    const req = makeRequest('http://localhost/api/sync')
    const res = await POST(req)

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const results = body.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(6)
    // The failed source should have error and status='failed'
    const failed = results.find((r) => r.status === 'failed')
    expect(failed).toBeDefined()
    expect(typeof failed?.error).toBe('string')
  })
})
