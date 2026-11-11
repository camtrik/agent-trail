/**
 * BFF API Proxy — GET /api/agent-tools/[tool]/sessions/[sessionId]
 *
 * Proxies single session detail request to the ingest service.
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
  _request: NextRequest,
  { params }: { params: Promise<{ tool: string; sessionId: string }> },
) {
  const { tool, sessionId } = await params

  try {
    if (tool === 'all') {
      const adapter = adapters[tool]
      const result = await adapter.getSession(sessionId)
      if (!result) {
        return NextResponse.json(
          { error: 'Session not found', sessionId },
          { status: 404 },
        )
      }
      return NextResponse.json(result)
    }

    const toolId = assertSourceToolId(tool)
    const adapter = adapters[toolId]

    const result = await adapter.getSession(sessionId)
    if (!result) {
      return NextResponse.json(
        { error: 'Session not found', sessionId },
        { status: 404 },
      )
    }
    return NextResponse.json(result)
  } catch (err) {
    const { error, code } = sanitizeError(err)
    return NextResponse.json({ error }, { status: code })
  }
}
