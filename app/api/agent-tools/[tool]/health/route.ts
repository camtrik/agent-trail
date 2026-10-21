/**
 * BFF API Proxy — GET /api/agent-tools/[tool]/health
 *
 * Proxies health check to the ingest service.
 * All source tools and the synthetic "all" shell scope share the same ingest
 * health endpoint.
 *
 * Per D-07: BFF proxy — frontend never calls ingest directly.
 */

import { NextRequest, NextResponse } from 'next/server'
import { assertAgentToolId } from '@/lib/agent-tools/registry'
import { allAdapter } from '@/lib/agent-tools/all/server-adapter'
import { openclawAdapter } from '@/lib/agent-tools/openclaw/server-adapter'
import { claudeCodeAdapter } from '@/lib/agent-tools/claude-code/server-adapter'
import { codexAdapter } from '@/lib/agent-tools/codex/server-adapter'
import { commandcodeAdapter } from '@/lib/agent-tools/commandcode/server-adapter'
import { opencodeAdapter } from '@/lib/agent-tools/opencode/server-adapter'
import { qoderAdapter } from '@/lib/agent-tools/qoder/server-adapter'
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
  { params }: { params: Promise<{ tool: string }> },
) {
  const { tool } = await params

  try {
    const toolId = assertAgentToolId(tool)
    const adapter = adapters[toolId]

    const result = await adapter.health()
    return NextResponse.json(result)
  } catch (err) {
    const { error, code } = sanitizeError(err)
    return NextResponse.json({ error }, { status: code })
  }
}
