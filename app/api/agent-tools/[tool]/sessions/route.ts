/**
 * BFF API Proxy — GET /api/agent-tools/[tool]/sessions
 *
 * Proxies session list requests to the ingest service (port 8078).
 * Automatically injects source filter based on the [tool] URL segment.
 *
 * Per D-07: BFF proxy — frontend never calls ingest directly.
 * Per D-08: Unified per-tool routing — single handler for all 3 tools.
 *
 * Caching: disabled so local sync/reindex changes are visible immediately.
 */

import { NextRequest, NextResponse } from 'next/server'
import { assertSourceToolId } from '@/lib/agent-tools/registry'
import { openclawAdapter } from '@/lib/agent-tools/openclaw/server-adapter'
import { claudeCodeAdapter } from '@/lib/agent-tools/claude-code/server-adapter'
import { codexAdapter } from '@/lib/agent-tools/codex/server-adapter'
import { commandcodeAdapter } from '@/lib/agent-tools/commandcode/server-adapter'
import { opencodeAdapter } from '@/lib/agent-tools/opencode/server-adapter'
import { qoderAdapter } from '@/lib/agent-tools/qoder/server-adapter'
import { sanitizeError } from '@/lib/agent-tools/server-adapter'
import type { AgentToolServerAdapter } from '@/lib/agent-tools/server-adapter'

/**
 * Adapter lookup map — O(1) dispatch by tool ID.
 * No tool-conditional branching — just adapter dispatch (per D-08).
 */
const adapters: Record<string, AgentToolServerAdapter> = {
  openclaw: openclawAdapter,
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  commandcode: commandcodeAdapter,
  opencode: opencodeAdapter,
  qoder: qoderAdapter,
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tool: string }> },
) {
  const { tool } = await params

  try {
    // Validate tool param at the trust boundary (T-04-03)
    const toolId = assertSourceToolId(tool)
    const adapter = adapters[toolId]

    // Forward all query params to ingest (the adapter injects source=toolId)
    const query: Record<string, string> = {}
    request.nextUrl.searchParams.forEach((value, key) => {
      query[key] = value
    })

    const result = await adapter.listSessions(query)
    return NextResponse.json(result)
  } catch (err) {
    const { error, code } = sanitizeError(err)
    return NextResponse.json({ error }, { status: code })
  }
}
