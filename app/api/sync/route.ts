import { NextResponse } from 'next/server'
import { fetchIngest, sanitizeError } from '@/lib/agent-tools/server-adapter'

const SOURCE_TYPES = ['openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder'] as const

interface IngestSyncResult {
  type: string
  syncResult: {
    sessionsInserted: number
    sessionsUpdated: number
    messagesInserted: number
    toolCallsInserted?: number
    toolResultEventsInserted?: number
    errors: string[]
  }
  status: string
}

/**
 * BFF sync route — aggregate all-source sync.
 *
 * POST /api/sync
 * Optional query param or JSON body: force=true
 *
 * Calls ingest POST /api/v1/sources/:type/sync for each source type in sequence.
 * Returns per-source results with sanitized errors so the frontend never sees
 * internal paths or stack traces.
 *
 * Per D-07: BFF proxy — frontend never calls ingest directly.
 */
export async function POST(request: Request) {
  // Accept force from query param or request body
  const url = new URL(request.url)
  const queryForce = url.searchParams.get('force')
  let bodyForce = false
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>
    bodyForce = body?.force === true || body?.force === 'true'
  } catch {
    // Body may be absent — ignore parse errors
  }
  const force = queryForce === 'true' || bodyForce

  const results = []

  for (const type of SOURCE_TYPES) {
    try {
      const result = await fetchIngest<IngestSyncResult>(
        `/api/v1/sources/${type}/sync`,
        {
          method: 'POST',
          body: force ? { force: true } : undefined,
        },
      )
      results.push(result)
    } catch (err) {
      const { error } = sanitizeError(err)
      results.push({ type, error, status: 'failed' })
    }
  }

  return NextResponse.json({ results, force })
}
