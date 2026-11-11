/**
 * Agents API Routes
 *
 * REST API endpoint for listing agents aggregated from session data.
 * Groups sessions by agent_name and returns summary statistics.
 * Also serves agent avatar images from workspace IDENTITY.md files.
 */

import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getDatabase } from '../db'
import type { SessionStatus } from '../../types/trace'
import { parseIdentityMarkdown } from '../parser/identity.js'

export const agentsRoutes = new Hono()

interface AgentRow {
  name: string
  session_count: number
  last_active_at: string | null
  latest_status: string
  tool_call_count: number
}

function parseAgentRow(row: AgentRow) {
  return {
    name: row.name,
    sessionCount: row.session_count,
    lastActiveAt: row.last_active_at,
    latestStatus: row.latest_status as SessionStatus,
    toolCallCount: row.tool_call_count,
  }
}

agentsRoutes.get('/api/v1/agents', (c) => {
  const source = c.req.query('source') as string

  if (!source) {
    return c.json({ error: 'source query parameter is required' }, 400)
  }

  if (!['openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder'].includes(source)) {
    return c.json({ error: 'Invalid source parameter' }, 400)
  }

  const db = getDatabase()

  const rows = db.prepare(`
    SELECT
      s.agent_name AS name,
      COUNT(DISTINCT s.id) AS session_count,
      MAX(s.started_at) AS last_active_at,
      (
        SELECT s2.status
        FROM sessions s2
        WHERE s2.source = s.source
          AND s2.agent_name = s.agent_name
        ORDER BY COALESCE(s2.ended_at, s2.started_at) DESC
        LIMIT 1
      ) AS latest_status,
      COALESCE(
        (SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_id IN (
          SELECT s3.id FROM sessions s3 WHERE s3.source = s.source AND s3.agent_name = s.agent_name
        )),
        0
      ) AS tool_call_count
    FROM sessions s
    WHERE s.source = ? AND s.agent_name IS NOT NULL
    GROUP BY s.agent_name
    ORDER BY last_active_at DESC
  `).all(source) as AgentRow[]

  return c.json({ agents: rows.map(parseAgentRow) })
})

// --- Avatar endpoint ---

const MIME_MAP: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
}

const AGENT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Resolve and read an agent's avatar file.
 * Extracted for testability — accepts explicit baseDir to avoid os.homedir() mocking.
 */
export function resolveAvatar(name: string, baseDir: string): { data: Buffer; mime: string } | null {
  // "main" agent uses ~/.openclaw/workspace/ (no suffix); others use workspace-{name}
  const workspaceSuffix = name === 'main' ? 'workspace' : `workspace-${name}`
  const workspaceDir = path.join(baseDir, '.openclaw', workspaceSuffix)

  const identityPath = path.join(workspaceDir, 'IDENTITY.md')
  if (!fs.existsSync(identityPath)) return null

  const content = fs.readFileSync(identityPath, 'utf-8')
  const fields = parseIdentityMarkdown(content)
  if (!fields.avatar) return null

  const avatarPath = path.resolve(workspaceDir, fields.avatar)
  if (!avatarPath.startsWith(workspaceDir + path.sep)) return null
  if (!fs.existsSync(avatarPath)) return null

  const ext = path.extname(avatarPath).slice(1).toLowerCase()
  return { data: fs.readFileSync(avatarPath), mime: MIME_MAP[ext] || 'application/octet-stream' }
}

agentsRoutes.get('/api/v1/agents/:name/avatar', (c) => {
  const name = c.req.param('name')

  if (!AGENT_NAME_RE.test(name)) {
    return c.json({ error: 'Invalid agent name' }, 400)
  }

  const result = resolveAvatar(name, os.homedir())

  if (!result) {
    return c.json({ error: 'Avatar not found' }, 404)
  }

  return new Response(new Uint8Array(result.data), {
    status: 200,
    headers: {
      'Content-Type': result.mime,
      'Cache-Control': 'public, max-age=3600',
    },
  })
})
