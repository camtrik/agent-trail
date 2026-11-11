import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { openDatabase, initSchema, closeDatabase, getDatabase } from '@/ingest/db';
import { sessionsRoutes } from '@/ingest/api/sessions';
import { overviewRoutes } from '@/ingest/api/overview';
import { getSessionUsageCosts, estimateSessionCost } from './session-pricing';
import { parseClaudeSession, parseClaudeSessionAppend } from '@/ingest/parser/claude';
import { writeSessionToDatabase } from '@/ingest/sync';
import type { TokenUsage } from '@/types/trace';

interface Request {
  model: string;
  usage?: TokenUsage;
  timestamp?: string;
}
const haiku = 'claude-haiku-5.5';
const sonnet = 'claude-sonnet-5.5';
const firstDay = '2026-11-01T12:00:00.000Z';
const secondDay = '2026-11-02T12:00:00.000Z';
const smallUsage = (requestId?: string): TokenUsage => ({ inputTokens: 60_000, outputTokens: 1_000, ...(requestId ? { requestId } : {}) });

describe('request-aware session and overview costs', () => {
  let dir: string;
  let dbPath: string;
  let app: Hono;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-pricing-'));
    dbPath = join(tmpdir(), `claude-pricing-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    initSchema();
    app = new Hono();
    app.route('/', sessionsRoutes);
    app.route('/', overviewRoutes);
  });
  afterEach(() => {
    closeDatabase(); rmSync(dir, { recursive: true, force: true });
    for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm']) rmSync(file, { force: true });
  });

  function seed(requests: Request[], override?: { input?: number; output?: number; cost?: number; status?: string }) {
    const db = getDatabase();
    const sum = (field: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens') => requests.reduce((n, r) => n + (r.usage?.[field] ?? 0), 0);
    const input = override?.input ?? sum('inputTokens');
    const output = override?.output ?? sum('outputTokens');
    const read = sum('cacheReadTokens');
    const write = sum('cacheWriteTokens');
    db.prepare(`INSERT INTO sessions (
      id, source, project, started_at, status, file_path, message_count, user_message_count,
      total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens, total_tokens,
      source_cost_usd, cost_pricing_status
    ) VALUES ('session', 'claude-code', '/project', ?, 'idle', '/session.jsonl', ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .run(firstDay, requests.length, input, output, read, write, input + output + read + write, override?.cost ?? null, override?.status ?? null);
    requests.forEach((request, i) => {
      db.prepare(`INSERT INTO messages (id, session_id, ordinal, role, content, model, timestamp, token_usage_json)
        VALUES (?, 'session', ?, 'assistant', 'answer', ?, ?, ?)`)
        .run(`message-${i}`, i, request.model, request.timestamp ?? firstDay, request.usage ? JSON.stringify(request.usage) : null);
    });
    db.exec(`INSERT INTO session_token_daily (session_id, source, project, usage_date, attribution,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens)
      SELECT 'session', 'claude-code', '/project', date(timestamp, 'localtime'), 'message',
        SUM(COALESCE(json_extract(token_usage_json, '$.inputTokens'), 0)),
        SUM(COALESCE(json_extract(token_usage_json, '$.outputTokens'), 0)),
        SUM(COALESCE(json_extract(token_usage_json, '$.cacheReadTokens'), 0)),
        SUM(COALESCE(json_extract(token_usage_json, '$.cacheWriteTokens'), 0)),
        SUM(COALESCE(json_extract(token_usage_json, '$.inputTokens'), 0) + COALESCE(json_extract(token_usage_json, '$.outputTokens'), 0))
      FROM messages WHERE session_id = 'session' GROUP BY date(timestamp, 'localtime')`);
    if (!requests.some((request) => request.usage)) {
      db.prepare(`UPDATE session_token_daily SET input_tokens = ?, output_tokens = ?, total_tokens = ? WHERE session_id = 'session'`)
        .run(input, output, input + output);
    }
  }
  const get = async (path: string) => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    return response.json();
  };

  it('adds two small requests without crossing the session total into the expensive tier', async () => {
    seed([{ model: haiku, usage: smallUsage('r1') }, { model: haiku, usage: smallUsage('r2') }]);
    expect(estimateSessionCost(getDatabase(), 'session')).toMatchObject({ cost: 0.013, pricingStatus: 'priced' });
    expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: 0.013, costPricingStatus: 'priced' });
    expect((await get('/api/v1/sessions?source=claude-code')).sessions[0]).toMatchObject({ estimatedCost: 0.013 });
    expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: 0.013, pricingStatus: 'priced' });
    expect((await get('/api/v1/overview/top-projects?window=all')).projects[0]).toMatchObject({ cost: 0.013 });
    expect((await get('/api/v1/overview/top-models?window=all')).models[0]).toMatchObject({ cost: 0.013, sessionCount: 1 });
  });

  it('prices cache-inclusive prompts at the expensive tier through both APIs', async () => {
    seed([{ model: haiku, usage: { requestId: 'cached', inputTokens: 10_000, cacheReadTokens: 100_000, outputTokens: 1_000 } }]);
    expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: 0.0125 });
    expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: 0.0125 });
  });

  it('attributes model switches and different days to their individual requests', async () => {
    seed([
      { model: haiku, usage: smallUsage('r1'), timestamp: firstDay },
      { model: sonnet, usage: { requestId: 'r2', inputTokens: 2_000, outputTokens: 10 }, timestamp: secondDay },
    ]);
    expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: 0.0106, costPricingStatus: 'priced' });
    expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: 0.0106, pricingStatus: 'priced' });
    const models = (await get('/api/v1/overview/top-models?window=all')).models;
    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: haiku, inputTokens: 60_000, outputTokens: 1_000, cost: 0.0065, sessionCount: 1 }),
      expect.objectContaining({ name: sonnet, inputTokens: 2_000, outputTokens: 10, cost: 0.0041, sessionCount: 1 }),
    ]));
    expect((await get('/api/v1/overview/daily-tokens?window=all')).days).toEqual([
      expect.objectContaining({ date: '2026-11-01', cost: 0.0065, pricingStatus: 'priced' }),
      expect.objectContaining({ date: '2026-11-02', cost: 0.0041, pricingStatus: 'priced' }),
    ]);
  });

  it('rounds after request summation so tiny Haiku requests are not discarded', () => {
    seed(Array.from({ length: 10 }, (_, i) => ({ model: haiku, usage: { requestId: `tiny-${i}`, inputTokens: 1, outputTokens: 0 } })));
    expect(estimateSessionCost(getDatabase(), 'session')).toMatchObject({ cost: 0.000001, pricingStatus: 'priced' });
  });

  it('preserves overlap token totals for other providers in model rankings', async () => {
    seed([{ model: 'gpt-5.4', usage: {
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, reasoningTokens: 10,
      totalTokens: 120, usageSemantics: 'overlap',
    } }]);
    getDatabase().prepare('UPDATE sessions SET total_reasoning_tokens = 10, total_tokens = 120').run();
    expect((await get('/api/v1/overview/top-models?window=all')).models[0]).toMatchObject({ totalTokens: 120 });
  });

  it('keeps tiered usage unknown without request identity, but retains safe fixed-rate fallback', () => {
    seed([{ model: haiku, usage: smallUsage() }]);
    expect(estimateSessionCost(getDatabase(), 'session')).toMatchObject({ cost: null, pricingStatus: 'unknown' });
    getDatabase().prepare('UPDATE messages SET model = ?, token_usage_json = NULL').run(sonnet);
    expect(estimateSessionCost(getDatabase(), 'session')).toMatchObject({ cost: 0.13, pricingStatus: 'priced' });
  });

  it('returns unknown for aggregate-only tiered data', async () => {
    seed([{ model: haiku }], { input: 120_000, output: 2_000 });
    expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: null, costPricingStatus: 'unknown' });
    expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: null, pricingStatus: 'unknown' });
  });

  it('keeps known subsets partial when request usage or models are missing', async () => {
    seed([{ model: haiku, usage: smallUsage('r1') }, { model: 'unknown', usage: smallUsage('r2') }]);
    expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: 0.0065, costPricingStatus: 'partial' });
    expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: 0.0065, pricingStatus: 'partial' });
    getDatabase().prepare('DELETE FROM messages WHERE ordinal = 1').run();
    expect(estimateSessionCost(getDatabase(), 'session')).toMatchObject({ cost: 0.0065, pricingStatus: 'partial' });
  });

  it('keeps duplicate request snapshots from shifting costs to a later day', async () => {
    seed([{ model: haiku, usage: smallUsage('same'), timestamp: firstDay },
      { model: haiku, usage: smallUsage('same'), timestamp: secondDay }]);
    expect((await get('/api/v1/overview/daily-tokens?window=all')).days).toEqual([
      expect.objectContaining({ cost: 0.0065, pricingStatus: 'priced' }),
      expect.objectContaining({ cost: 0, pricingStatus: 'priced' }),
    ]);
  });

  it('does not allocate undated request cost to every daily rollup', async () => {
    seed([{ model: haiku, usage: smallUsage('r1') }, { model: haiku, usage: smallUsage('r2'), timestamp: secondDay }]);
    getDatabase().prepare('UPDATE messages SET timestamp = NULL').run();
    expect(estimateSessionCost(getDatabase(), 'session')).toMatchObject({ cost: 0.013, pricingStatus: 'priced' });
    expect((await get('/api/v1/overview/daily-tokens?window=all')).days).toEqual([
      expect.objectContaining({ cost: null, pricingStatus: 'unknown' }),
      expect.objectContaining({ cost: null, pricingStatus: 'unknown' }),
    ]);
  });

  it('does not price aggregate mixed-model usage using its final model', async () => {
    seed([{ model: haiku }, { model: sonnet }], { input: 120_000, output: 2_000 });
    expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: null, costPricingStatus: 'unknown' });
    expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: null, pricingStatus: 'unknown' });
  });

  it('rejects corrupt usage instead of turning invalid token values into a precise price', () => {
    seed([{ model: haiku, usage: smallUsage('r1') }]);
    getDatabase().prepare("UPDATE messages SET token_usage_json = '{bad json}'").run();
    expect(estimateSessionCost(getDatabase(), 'session')).toMatchObject({ cost: null, pricingStatus: 'unknown' });
  });

  it.each([[0, 'reported_zero', 'priced'], [0.42, 'partial', 'partial'], [0.42, 'source_reported', 'priced']])(
    'keeps source-reported cost %s and status %s authoritative', async (cost, status, expectedStatus) => {
      seed([{ model: haiku, usage: smallUsage('r1') }], { cost: Number(cost), status: String(status) });
      expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: cost, costPricingStatus: expectedStatus });
      expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: cost, pricingStatus: expectedStatus });
      expect((await get('/api/v1/overview/top-projects?window=all')).projects[0]).toMatchObject({ cost, pricingStatus: expectedStatus });
    },
  );

  it.each(['source_reported', 'partial'])(
    'keeps model tokens visible without splitting a %s source cost', async (status) => {
      seed([
        { model: haiku, usage: smallUsage('r1') },
        { model: sonnet, usage: { requestId: 'r2', inputTokens: 2_000, outputTokens: 10 } },
      ], { cost: 0.42, status });
      const pricingStatus = status === 'partial' ? 'partial' : 'priced';
      expect(await get('/api/v1/sessions/session')).toMatchObject({ estimatedCost: 0.42, costPricingStatus: pricingStatus });
      expect(await get('/api/v1/overview/aggregates?window=all')).toMatchObject({ totalCost: 0.42, pricingStatus });
      expect((await get('/api/v1/overview/top-projects?window=all')).projects[0]).toMatchObject({ cost: 0.42, pricingStatus });
      expect((await get('/api/v1/overview/daily-tokens?window=all')).days[0]).toMatchObject({ cost: 0.42, pricingStatus });
      const models = (await get('/api/v1/overview/top-models?window=all')).models;
      expect(models).toHaveLength(2);
      expect(models).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: haiku, inputTokens: 60_000, outputTokens: 1_000, totalTokens: 61_000,
          sessionCount: 1, cost: null, pricingStatus: 'unknown' }),
        expect.objectContaining({ name: sonnet, inputTokens: 2_000, outputTokens: 10, totalTokens: 2_010,
          sessionCount: 1, cost: null, pricingStatus: 'unknown' }),
      ]));
    },
  );

  it('persists request identity from distinct Claude UUIDs and bills cumulative snapshots once', async () => {
    const file = join(dir, 'stream.jsonl');
    writeFileSync(file, [100, 1_000, 1_000].map((output, i) => JSON.stringify({
      uuid: `uuid-${i}`, type: 'assistant', timestamp: i === 0 ? firstDay : secondDay,
      message: { id: 'msg-shared-request', role: 'assistant', model: haiku, content: 'stream',
        usage: { input_tokens: 60_000, output_tokens: output } },
    })).join('\n') + '\n');
    const parsed = await parseClaudeSession(file, 'test');
    expect(parsed.messages.map((m) => m.tokenUsage?.requestId)).toEqual(Array(3).fill('msg-shared-request'));
    const append = await parseClaudeSessionAppend(file, 'test', {
      startOffset: 0, endOffset: statSync(file).size, startLine: 0,
      startOrdinal: 0, startTurnIndex: -1, sessionId: parsed.session.id, parserVersion: 'test',
    });
    expect(append.messages.map((m) => m.tokenUsage?.requestId)).toEqual(Array(3).fill('msg-shared-request'));

    expect(writeSessionToDatabase(parsed, getDatabase(), file).errors).toEqual([]);
    expect(estimateSessionCost(getDatabase(), parsed.session.id)).toMatchObject({ cost: 0.0065, pricingStatus: 'priced' });
    expect(getSessionUsageCosts(getDatabase(), parsed.session.id)).toHaveLength(1);
    const days = (await get('/api/v1/overview/daily-tokens?window=all')).days;
    expect(days.map((day: { cost: number | null }) => day.cost)).toEqual([0, 0.0065]);
  });
});
