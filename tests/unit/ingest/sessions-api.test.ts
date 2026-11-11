import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { sessionsRoutes } from '@/ingest/api/sessions'
import { closeDatabase, getDatabase, initSchema, openDatabase } from '@/ingest/db'

describe('sessions API', () => {
  let dbPath: string

  beforeEach(() => {
    dbPath = join(tmpdir(), `sessions-api-test-${randomUUID()}.db`)
    openDatabase({ path: dbPath })
    initSchema()
  })

  afterEach(() => {
    closeDatabase()
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
  })

  it('sorts by user-facing activity timestamps for updated_at (excluding last_sync_at)', async () => {
    const db = getDatabase()
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, source, project, name, started_at, ended_at, status,
        message_count, user_message_count, total_output_tokens, has_tool_calls,
        parser_malformed_lines, is_truncated, termination_status,
        file_path, file_mtime, last_sync_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    insert.run(
      'older-start-recent-sync',
      'codex',
      '/project',
      'Recent sync',
      '2024-01-01T00:00:00.000Z',
      null,
      'idle',
      1,
      1,
      0,
      0,
      0,
      0,
      '',
      '/tmp/recent.jsonl',
      '2024-01-01T00:00:00.000Z',
      '2026-05-07T11:00:00.000Z',
    )
    insert.run(
      'newer-start-stale-sync',
      'codex',
      '/project',
      'Stale sync',
      '2025-01-01T00:00:00.000Z',
      null,
      'idle',
      1,
      1,
      0,
      0,
      0,
      0,
      '',
      '/tmp/stale.jsonl',
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    )

    const response = await sessionsRoutes.request(
      'http://localhost/api/v1/sessions?source=codex&sort=updated_at&order=desc',
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([
      'newer-start-stale-sync',
      'older-start-recent-sync',
    ])
    expect(body.sessions[0].updatedAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('ignores whole-database file_mtime for Qoder updated_at sorting', async () => {
    const db = getDatabase()
    const insert = db.prepare(`
      INSERT INTO sessions (
        id, source, project, name, started_at, ended_at, status,
        message_count, user_message_count, total_output_tokens, has_tool_calls,
        parser_malformed_lines, is_truncated, termination_status,
        file_path, file_mtime, last_sync_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    insert.run(
      'qoder:older-session-fresh-db',
      'qoder',
      '/project',
      'Older session in recently touched DB',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:10:00.000Z',
      'idle',
      1,
      1,
      0,
      0,
      0,
      0,
      '',
      '/tmp/qoder/local.db#older',
      '2026-05-01T00:00:00.000Z',
      '2026-05-01T00:00:00.000Z',
    )
    insert.run(
      'qoder:newer-session-stale-db',
      'qoder',
      '/project',
      'Newer session in stale DB',
      '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:10:00.000Z',
      'idle',
      1,
      1,
      0,
      0,
      0,
      0,
      '',
      '/tmp/qoder/local.db#newer',
      '2026-02-01T00:10:00.000Z',
      '2026-02-01T00:10:00.000Z',
    )

    const response = await sessionsRoutes.request(
      'http://localhost/api/v1/sessions?source=qoder&sort=updated_at&order=desc',
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.sessions.map((session: { id: string }) => session.id)).toEqual([
      'qoder:newer-session-stale-db',
      'qoder:older-session-fresh-db',
    ])
    expect(body.sessions[1].updatedAt).toBe('2026-01-01T00:10:00.000Z')
  })

  describe('Codex subagent filtering via relationship_type', () => {
    function insertSessionRow(
      db: Database.Database,
      id: string,
      source: string,
      relationshipType: string,
      parentSessionId: string | null,
      rootSessionId: string | null,
    ) {
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          message_count, user_message_count, total_output_tokens, has_tool_calls,
          parser_malformed_lines, is_truncated, termination_status,
          file_path, relationship_type, parent_session_id, root_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, source, '/project', `${id} name`,
        '2024-01-01T00:00:00.000Z', null, 'idle',
        1, 1, 0, 0, 0, 0, '',
        `/tmp/${id}.jsonl`, relationshipType, parentSessionId, rootSessionId,
      )
    }

    it('hides Codex subagents by default when source=codex', async () => {
      const db = getDatabase()
      insertSessionRow(db, 'codex-root-001', 'codex', 'root', null, null)
      insertSessionRow(db, 'codex-child-001', 'codex', 'subagent', 'codex-root-001', 'codex-root-001')

      const response = await sessionsRoutes.request(
        'http://localhost/api/v1/sessions?source=codex',
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['codex-root-001'])
      expect(body.pagination.total).toBe(1)
    })

    it('includes Codex subagents when includeChildren=true', async () => {
      const db = getDatabase()
      insertSessionRow(db, 'codex-root-002', 'codex', 'root', null, null)
      insertSessionRow(db, 'codex-child-002', 'codex', 'subagent', 'codex-root-002', 'codex-root-002')

      const response = await sessionsRoutes.request(
        'http://localhost/api/v1/sessions?source=codex&includeChildren=true',
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.sessions.map((s: { id: string }) => s.id).sort()).toEqual(
        ['codex-root-002', 'codex-child-002'].sort(),
      )
      expect(body.pagination.total).toBe(2)
    })
  })

  describe('Phase 13 table query support', () => {
    function insertTableSession(
      db: Database.Database,
      id: string,
      overrides: {
        name?: string
        project?: string
        source?: string
        startedAt?: string
        endedAt?: string | null
        status?: string
        gitBranch?: string | null
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
        truncated?: boolean
      } = {},
    ) {
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          total_tokens, has_tool_calls, parser_malformed_lines, is_truncated,
          termination_status, file_path, git_branch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        overrides.source ?? 'codex',
        overrides.project ?? '/workspace/phase13',
        overrides.name ?? `${id} title`,
        overrides.startedAt ?? '2026-05-17T00:00:00.000Z',
        overrides.endedAt ?? '2026-05-17T00:02:00.000Z',
        overrides.status ?? 'idle',
        2,
        1,
        overrides.outputTokens ?? 20,
        overrides.inputTokens ?? 10,
        overrides.totalTokens ?? ((overrides.inputTokens ?? 10) + (overrides.outputTokens ?? 20)),
        1,
        0,
        overrides.truncated ? 1 : 0,
        '',
        `/tmp/${id}.jsonl`,
        overrides.gitBranch ?? 'feat/phase-13',
      )
    }

    function insertUserMessage(db: Database.Database, sessionId: string, content: string, model = 'gpt-5.3-codex') {
      db.prepare(`
        INSERT INTO messages (
          id, session_id, ordinal, role, content, timestamp, model,
          has_tool_use, source_file
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${sessionId}-m1`,
        sessionId,
        1,
        'user',
        content,
        '2026-05-17T00:00:00.000Z',
        model,
        0,
        `/tmp/${sessionId}.jsonl`,
      )
    }

    it('filters by backend search and returns row enrichment fields', async () => {
      const db = getDatabase()
      insertTableSession(db, 'phase13-match', {
        name: 'Wire backend search and activity sorting',
        gitBranch: 'feat/backend-filter',
        inputTokens: 1_000,
        outputTokens: 2_000,
      })
      insertTableSession(db, 'phase13-other', { name: 'Unrelated session' })
      insertUserMessage(db, 'phase13-match', 'Add backend search and activity sorting for the sessions table.')
      insertUserMessage(db, 'phase13-other', 'Also mentions activity sorting only in the message body.', 'unknown-model')
      db.prepare(`
        INSERT INTO tool_calls (session_id, message_ordinal, tool_id, name, category, input_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('phase13-match', 1, 'tool-1', 'rg', 'Grep', '{}', 'success')
      db.prepare(`
        INSERT INTO subagent_links (session_id, subagent_session_id, subagent_source, relationship, message_ordinal)
        VALUES (?, ?, ?, ?, ?)
      `).run('phase13-match', 'child-session', 'codex', 'spawned', 1)

      const response = await sessionsRoutes.request(
        'http://localhost/api/v1/sessions?source=codex&q=activity%20sorting',
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.pagination.total).toBe(1)
      expect(body.sessions[0]).toMatchObject({
        id: 'phase13-match',
        model: 'gpt-5.3-codex',
        gitBranch: 'feat/backend-filter',
        inputTokens: 1_000,
        outputTokens: 2_000,
        activityCounts: {
          toolCalls: 1,
          subagents: 1,
        },
      })
      expect(body.sessions[0].summary).toContain('backend search')
      expect(body.sessions[0].estimatedCost).toBeGreaterThan(0)
    })

    it('normalizes provider-prefixed model labels in session rows', async () => {
      const db = getDatabase()
      insertTableSession(db, 'opencode-glm', {
        source: 'opencode',
        name: 'OpenCode GLM session',
        inputTokens: 800,
        outputTokens: 1200,
        totalTokens: 2000,
      })
      insertUserMessage(db, 'opencode-glm', 'Normalize this model', 'zhipuai-coding-plan/glm-5.1')

      const response = await sessionsRoutes.request(
        'http://localhost/api/v1/sessions?source=opencode',
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.sessions[0]).toMatchObject({
        id: 'opencode-glm',
        model: 'glm5.1',
      })
      expect(body.sessions[0].estimatedCost).toBeGreaterThan(0)
    })

    it('sorts by activity count on the backend', async () => {
      const db = getDatabase()
      insertTableSession(db, 'low-activity')
      insertTableSession(db, 'high-activity')
      insertUserMessage(db, 'low-activity', 'small')
      insertUserMessage(db, 'high-activity', 'busy')
      const insertTool = db.prepare(`
        INSERT INTO tool_calls (session_id, message_ordinal, tool_id, name, category, input_json, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      insertTool.run('low-activity', 1, 'low-tool', 'read', 'Read', '{}', 'success')
      insertTool.run('high-activity', 1, 'high-tool-1', 'rg', 'Grep', '{}', 'success')
      insertTool.run('high-activity', 1, 'high-tool-2', 'edit', 'Edit', '{}', 'success')

      const response = await sessionsRoutes.request(
        'http://localhost/api/v1/sessions?source=codex&sort=activity&order=desc',
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.sessions.map((s: { id: string }) => s.id).slice(0, 2)).toEqual([
        'high-activity',
        'low-activity',
      ])
    })

    it('filters by starred and truncated table states', async () => {
      const db = getDatabase()
      insertTableSession(db, 'starred-truncated', { truncated: true })
      insertTableSession(db, 'starred-normal')
      insertUserMessage(db, 'starred-truncated', 'truncated')
      insertUserMessage(db, 'starred-normal', 'normal')
      db.prepare('INSERT INTO session_stars (session_id, starred_at) VALUES (?, ?)').run(
        'starred-truncated',
        '2026-05-17T00:00:00.000Z',
      )

      const response = await sessionsRoutes.request(
        'http://localhost/api/v1/sessions?source=codex&starred=true&status=truncated',
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['starred-truncated'])
      expect(body.pagination.total).toBe(1)
    })
  })
})
