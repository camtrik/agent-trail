import { afterEach, expect, it, vi } from 'vitest'
import { GET as getSessions } from '@/app/api/agent-tools/[tool]/sessions/route'
import { GET as getTurns } from '@/app/api/agent-tools/[tool]/sessions/[sessionId]/turns/route'
import { NextRequest } from 'next/server'

const response = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json' },
})
afterEach(() => vi.unstubAllGlobals())

it('routes Command Code BFF session lists through ingest with source scoping', async () => {
  const fetchSpy = vi.fn(async (url: string) => { expect(url).toContain('source=commandcode'); return response({ sessions: [], total: 0 }) })
  vi.stubGlobal('fetch', fetchSpy)
  const request = new NextRequest('http://localhost/api/agent-tools/commandcode/sessions?source=codex')
  expect((await getSessions(request, { params: Promise.resolve({ tool: 'commandcode' }) })).status).toBe(200)
  expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('source=commandcode')
})

it('exposes Command Code replay through the BFF with pagination', async () => {
  const fetchSpy = vi.fn(async (url: string) => response(url.includes('/turns')
    ? { turns: [], pagination: { total: 0, offset: 2, limit: 10 } }
    : { id: 'commandcode:fixture', source: 'commandcode' }))
  vi.stubGlobal('fetch', fetchSpy)
  const request = new NextRequest('http://localhost/api/agent-tools/commandcode/sessions/commandcode:fixture/turns?offset=2&limit=10')
  const result = await getTurns(request, { params: Promise.resolve({ tool: 'commandcode', sessionId: 'commandcode:fixture' }) })
  expect(result.status).toBe(200)
  expect(fetchSpy.mock.calls.some(([url]) => url.includes('offset=2&limit=10'))).toBe(true)
})

it('rejects replay requests whose session belongs to another source', async () => {
  const fetchSpy = vi.fn(async () => response({ id: 'codex:fixture', source: 'codex' }))
  vi.stubGlobal('fetch', fetchSpy)
  const request = new NextRequest('http://localhost/api/agent-tools/commandcode/sessions/codex:fixture/turns')
  const result = await getTurns(request, { params: Promise.resolve({ tool: 'commandcode', sessionId: 'codex:fixture' }) })
  expect(result.status).toBe(404)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})
