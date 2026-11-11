/**
 * BFF API Proxy — GET /api/agent-tools/[tool]/sessions/[sessionId]/turns
 *
 * Proxies session turns request to the ingest service.
 * Validates sessionId format before proxying (T-04-04).
 *
 * Per D-07: BFF proxy — frontend never calls ingest directly.
 * Caching: no-store — always fetch fresh detail data (per UI-SPEC).
 */

import { NextRequest, NextResponse } from 'next/server'
import { assertSourceToolId } from '@/lib/agent-tools/registry'
import { openclawAdapter } from '@/lib/agent-tools/openclaw/server-adapter'
import { claudeCodeAdapter } from '@/lib/agent-tools/claude-code/server-adapter'
import { codexAdapter } from '@/lib/agent-tools/codex/server-adapter'
import { commandcodeAdapter } from '@/lib/agent-tools/commandcode/server-adapter'
import { opencodeAdapter } from '@/lib/agent-tools/opencode/server-adapter'
import { qoderAdapter } from '@/lib/agent-tools/qoder/server-adapter'
import { allAdapter } from '@/lib/agent-tools/all/server-adapter'
import { sanitizeError } from '@/lib/agent-tools/server-adapter'
import type { AgentToolServerAdapter } from '@/lib/agent-tools/server-adapter'

const adapters: Record<string, AgentToolServerAdapter> = {
  all: allAdapter,
  openclaw: openclawAdapter,
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  commandcode: commandcodeAdapter,
  opencode: opencodeAdapter,
  qoder: qoderAdapter,
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tool: string; sessionId: string }> },
) {
  const { tool, sessionId } = await params

  try {
    // Parse offset/limit query params
    const { searchParams } = new URL(request.url)
    const rawOffset = searchParams.get('offset')
    const rawLimit = searchParams.get('limit')
    const offset = rawOffset ? parseInt(rawOffset, 10) : undefined
    const limit = rawLimit ? parseInt(rawLimit, 10) : undefined

    // Validate offset/limit
    if (offset !== undefined && (isNaN(offset) || offset < 0)) {
      return NextResponse.json(
        { error: 'Invalid offset parameter, must be non-negative integer' },
        { status: 400 },
      )
    }
    if (limit !== undefined && (isNaN(limit) || limit < 0)) {
      return NextResponse.json(
        { error: 'Invalid limit parameter, must be non-negative integer' },
        { status: 400 },
      )
    }

    // Cap limit to prevent resource exhaustion (100 max at BFF layer)
    const cappedLimit =
      limit !== undefined ? Math.min(limit, 100) : undefined

    if (tool === 'all') {
      const adapter = adapters[tool]
      const result = await adapter.getSessionTurns(sessionId, {
        offset,
        limit: cappedLimit,
      })
      return NextResponse.json(result)
    }

    const toolId = assertSourceToolId(tool)
    const adapter = adapters[toolId]

    const result = await adapter.getSessionTurns(sessionId, {
      offset,
      limit: cappedLimit,
    })
    return NextResponse.json(result)
  } catch (err) {
    const { error, code } = sanitizeError(err)
    return NextResponse.json({ error }, { status: code })
  }
}
