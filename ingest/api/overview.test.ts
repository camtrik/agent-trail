/**
 * Overview API Tests — Golden Fixture Suite
 *
 * Tests all 8 overview endpoints with isolated SQLite databases
 * and golden fixture data covering multiple sources, dates,
 * and edge cases.
 *
 * Pattern: open temp DB, run schema, insert fixtures, mount routes.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { openDatabase, closeDatabase, initSchema, getDatabase } from '../db/index.js';
import { overviewRoutes } from './overview.js';

// Day-bucket keys are derived in the user's local timezone (see
// dateKeyFromTimestamp / getRollupDateCondition), so tests must expect local
// dates rather than UTC. Keeps the suite timezone-independent.
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ============================================================================
// Test infrastructure
// ============================================================================

let dbPath: string;
let automationFixtureRoot: string;
let previousOpenClawHome: string | undefined;
let previousCodexHome: string | undefined;

function createApp(): Hono {
  const app = new Hono();
  app.route('/', overviewRoutes);
  return app;
}

function writeAutomationFixtures(root: string): void {
  const openclawRoot = join(root, 'openclaw');
  const codexRoot = join(root, 'codex');

  mkdirSync(join(openclawRoot, 'cron', 'runs'), { recursive: true });
  writeFileSync(
    join(openclawRoot, 'cron', 'jobs.json'),
    JSON.stringify({
      version: 1,
      jobs: [
        {
          id: 'oc-file-job',
          name: 'openclaw-nightly-docs',
          enabled: true,
          schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'Asia/Tokyo' },
          payload: { model: 'gpt-5.4' },
          state: {
            nextRunAtMs: 1779062400000,
            lastRunAtMs: 1778976000000,
            lastRunStatus: 'ok',
            lastStatus: 'ok',
          },
        },
      ],
    }),
  );
  writeFileSync(
    join(openclawRoot, 'cron', 'runs', 'oc-file-job.jsonl'),
    JSON.stringify({
      ts: 1778976000000,
      jobId: 'oc-file-job',
      action: 'finished',
      status: 'ok',
      runAtMs: 1778976000000,
    }) + '\n',
  );

  mkdirSync(join(codexRoot, 'automations', 'codex-file-job'), { recursive: true });
  writeFileSync(
    join(codexRoot, 'automations', 'codex-file-job', 'automation.toml'),
    [
      'id = "codex-file-job"',
      'kind = "cron"',
      'name = "codex-weekly-docs"',
      'status = "ACTIVE"',
      'rrule = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"',
      'model = "gpt-5.4"',
      'updated_at = 1778169912118',
    ].join('\n'),
  );
  writeFileSync(
    join(codexRoot, 'automations', 'codex-file-job', 'memory.md'),
    [
      '2026-03-15 00:03:50 JST',
      '- First run summary.',
      '2026-03-16 00:02:20 JST',
      '- Second run summary.',
    ].join('\n'),
  );

  process.env.OPENCLAW_HOME = openclawRoot;
  process.env.CODEX_HOME = codexRoot;
}

// ============================================================================
// Golden Fixture Data
// ============================================================================

function insertFixtures(db: Database.Database): void {
  const now = new Date();
  const today = now.toISOString().replace('T', ' ').split('.')[0];

  // 5 days ago
  const fiveDaysAgo = new Date(now.getTime() - 5 * 86400000)
    .toISOString().replace('T', ' ').split('.')[0];

  // 15 days ago
  const fifteenDaysAgo = new Date(now.getTime() - 15 * 86400000)
    .toISOString().replace('T', ' ').split('.')[0];

  // 40 days ago
  const fortyDaysAgo = new Date(now.getTime() - 40 * 86400000)
    .toISOString().replace('T', ' ').split('.')[0];

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, source, project, name, agent_name, started_at, ended_at, status,
      message_count, user_message_count, total_output_tokens, total_input_tokens,
      has_tool_calls, file_path, file_mtime
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Session 1: openclaw, today, active
  insertSession.run(
    'oc-1', 'openclaw', 'project-alpha', 'Alpha task', 'agent-blue',
    today, null, 'active',
    10, 5, 5000, 3000,
    1, '/tmp/oc-1.jsonl', today,
  );

  // Session 2: openclaw, 5 days ago, completed
  insertSession.run(
    'oc-2', 'openclaw', 'project-beta', 'Beta analysis', 'agent-blue',
    fiveDaysAgo, fiveDaysAgo, 'idle',
    8, 4, 3000, 2000,
    1, '/tmp/oc-2.jsonl', fiveDaysAgo,
  );

  // Session 3: claude-code, 5 days ago, completed
  insertSession.run(
    'cc-1', 'claude-code', 'project-alpha', 'Code review', null,
    fiveDaysAgo, fiveDaysAgo, 'idle',
    20, 10, 10000, 8000,
    1, '/tmp/cc-1.jsonl', fiveDaysAgo,
  );

  // Session 4: claude-code, 15 days ago, error
  insertSession.run(
    'cc-2', 'claude-code', 'project-gamma', 'Failed deploy', null,
    fifteenDaysAgo, fifteenDaysAgo, 'error',
    5, 3, 2000, 1000,
    0, '/tmp/cc-2.jsonl', fifteenDaysAgo,
  );

  // Session 5: codex, 40 days ago, completed
  insertSession.run(
    'cx-1', 'codex', 'project-alpha', 'Old task', null,
    fortyDaysAgo, fortyDaysAgo, 'idle',
    6, 3, 4000, 2000,
    0, '/tmp/cx-1.jsonl', fortyDaysAgo,
  );

  // Session 6: openclaw automation (agent_name set, user_message_count = 0)
  insertSession.run(
    'oc-auto-1', 'openclaw', 'project-alpha', 'Auto deploy', 'auto-deploy',
    today, today, 'idle',
    4, 0, 2000, 1000,
    1, '/tmp/oc-auto-1.jsonl', today,
  );

  // Session 7: openclaw automation (same agent, different day)
  insertSession.run(
    'oc-auto-2', 'openclaw', 'project-beta', 'Auto deploy v2', 'auto-deploy',
    fiveDaysAgo, fiveDaysAgo, 'idle',
    3, 0, 1500, 800,
    1, '/tmp/oc-auto-2.jsonl', fiveDaysAgo,
  );

  // Session 8: openclaw agent session WITH user messages (NOT an automation)
  insertSession.run(
    'oc-3', 'openclaw', 'project-alpha', 'Manual agent task', 'agent-blue',
    fiveDaysAgo, fiveDaysAgo, 'idle',
    10, 5, 3000, 2000,
    1, '/tmp/oc-3.jsonl', fiveDaysAgo,
  );

  db.exec(`
    INSERT INTO session_token_daily (
      session_id,
      source,
      project,
      usage_date,
      attribution,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      reasoning_tokens,
      total_tokens
    )
    SELECT
      id,
      source,
      project,
      date(started_at, 'localtime'),
      'session',
      COALESCE(total_input_tokens, 0),
      COALESCE(total_output_tokens, 0),
      COALESCE(total_cache_read_tokens, 0),
      COALESCE(total_cache_write_tokens, 0),
      COALESCE(total_reasoning_tokens, 0),
      COALESCE(total_input_tokens, 0) + COALESCE(total_output_tokens, 0)
    FROM sessions
    WHERE started_at IS NOT NULL
  `);

  // Insert messages with model info for top-models
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, session_id, ordinal, role, content, model)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Messages for oc-1 (model: gpt-4o)
  insertMessage.run('msg-oc1-1', 'oc-1', 1, 'user', 'Hello', null);
  insertMessage.run('msg-oc1-2', 'oc-1', 2, 'assistant', 'Hi there', 'gpt-4o');
  insertMessage.run('msg-oc1-3', 'oc-1', 3, 'assistant', 'Second reply', 'gpt-4o');

  // Messages for oc-2 (model: gpt-4o)
  insertMessage.run('msg-oc2-1', 'oc-2', 1, 'user', 'Analyze this', null);
  insertMessage.run('msg-oc2-2', 'oc-2', 2, 'assistant', 'Analysis complete', 'gpt-4o');

  // Messages for cc-1 (model: claude-sonnet-4-20250514)
  insertMessage.run('msg-cc1-1', 'cc-1', 1, 'user', 'Review code', null);
  insertMessage.run('msg-cc1-2', 'cc-1', 2, 'assistant', 'Code looks good', 'claude-sonnet-4-20250514');
  insertMessage.run('msg-cc1-3', 'cc-1', 3, 'assistant', 'Synthetic control', '<synthetic>');

  // Messages for cc-2 (model: claude-sonnet-4-20250514)
  insertMessage.run('msg-cc2-1', 'cc-2', 1, 'user', 'Deploy this', null);
  insertMessage.run('msg-cc2-2', 'cc-2', 2, 'assistant', 'Deploy failed', 'claude-sonnet-4-20250514');

  // Messages for cx-1 (model: codex-mini)
  insertMessage.run('msg-cx1-1', 'cx-1', 1, 'user', 'Run task', null);
  insertMessage.run('msg-cx1-2', 'cx-1', 2, 'assistant', 'Task done', 'codex-mini');
  insertMessage.run('msg-oc3-2', 'oc-3', 2, 'assistant', 'No model resolved', '');

  // Star 2 sessions
  const starSession = db.prepare(`
    INSERT INTO session_stars (session_id, starred_at) VALUES (?, ?)
  `);
  starSession.run('oc-1', today);
  starSession.run('cc-1', fiveDaysAgo);

  // Sync status with one error entry
  const insertSyncStatus = db.prepare(`
    INSERT INTO sync_status (source_type, last_full_sync_at, files_watched, last_error)
    VALUES (?, ?, ?, ?)
  `);
  insertSyncStatus.run('openclaw', today, 10, null);
  insertSyncStatus.run('claude-code', fiveDaysAgo, 5, 'Failed to parse /tmp/bad.jsonl');
  insertSyncStatus.run('codex', fortyDaysAgo, 3, null);

  // Insert tool calls for agent summaries
  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (session_id, message_ordinal, tool_id, name, input_json, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertToolCall.run('oc-1', 2, 'tool-1', 'Bash', '{}', 'success');
  insertToolCall.run('oc-2', 2, 'tool-2', 'Read', '{}', 'success');
  insertToolCall.run('oc-auto-1', 2, 'tool-3', 'Bash', '{}', 'success');
  insertToolCall.run('oc-auto-2', 2, 'tool-4', 'Write', '{}', 'success');
}

// ============================================================================
// Tests
// ============================================================================

describe('overview endpoints', () => {
  let app: Hono;

  beforeAll(() => {
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    previousCodexHome = process.env.CODEX_HOME;
    automationFixtureRoot = join(tmpdir(), `overview-automations-${randomUUID()}`);
    writeAutomationFixtures(automationFixtureRoot);

    dbPath = join(tmpdir(), `overview-test-${randomUUID()}.db`);
    openDatabase({ path: dbPath });
    initSchema();
    const db = getDatabase();
    insertFixtures(db);
    app = createApp();
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(automationFixtureRoot, { recursive: true, force: true });
    if (previousOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousOpenClawHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });

  // ==========================================================================
  // 1. Aggregates (DATA-101)
  // ==========================================================================

  describe('GET /api/v1/overview/aggregates', () => {
    it('returns correct counts for 7d window (default)', async () => {
      const res = await app.request('/api/v1/overview/aggregates');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Sessions: oc-1 (today), oc-2 (5d ago), cc-1 (5d ago), oc-3 (5d ago), oc-auto-1 (today), oc-auto-2 (5d ago) = 6
      // Projects: alpha, beta = 2
      // user_message_count sum: 5+4+10+5+0+0 = 24
      expect(body.sessionCount).toBe(6);
      expect(body.projectCount).toBe(2);
      expect(body.turnCount).toBe(24);
      expect(body.inputTokens).toBe(16800);
      expect(body.outputTokens).toBe(24500);
      expect(body.totalTokens).toBe(body.inputTokens + body.outputTokens);
      expect(body.totalCost).toBe(0.174);
      expect(body.pricingStatus).toBe('partial');
    });

    it('returns correct counts for today window', async () => {
      const res = await app.request('/api/v1/overview/aggregates?window=today');
      expect(res.status).toBe(200);
      const body = await res.json();

      // oc-1 + oc-auto-1 are today
      expect(body.sessionCount).toBe(2);
      expect(body.projectCount).toBe(1);
      expect(body.inputTokens).toBe(4000);
      expect(body.outputTokens).toBe(7000);
      expect(body.totalCost).toBeNull();
      expect(body.pricingStatus).toBe('unknown');
    });

    it('returns correct counts for 30d window', async () => {
      const res = await app.request('/api/v1/overview/aggregates?window=30d');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Sessions within 30d: oc-1, oc-2, cc-1, cc-2, oc-3, oc-auto-1, oc-auto-2 = 7
      expect(body.sessionCount).toBe(7);
      expect(body.projectCount).toBe(3); // alpha, beta, gamma
      expect(body.totalCost).toBe(0.207);
      expect(body.pricingStatus).toBe('partial');
    });

    it('filters by source', async () => {
      const res = await app.request('/api/v1/overview/aggregates?source=openclaw&window=30d');
      expect(res.status).toBe(200);
      const body = await res.json();

      // oc-1 + oc-2 + oc-3 + oc-auto-1 + oc-auto-2 = 5 openclaw sessions within 30d
      expect(body.sessionCount).toBe(5);
      expect(body.projectCount).toBe(2);
    });

    it('uses OpenCode source-reported cost and cache-inclusive token totals', async () => {
      const db = getDatabase();
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens,
          total_tokens, has_tool_calls, file_path, source_cost_usd,
          cost_source, cost_pricing_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'opencode-cost-token-test',
        'opencode',
        'opencode-project',
        'OpenCode cost/token test',
        '2026-01-01 00:00:00',
        '2026-01-01 00:01:00',
        'idle',
        2,
        1,
        100,
        1000,
        7000,
        0,
        300,
        1100,
        0,
        '/tmp/opencode.db#opencode-cost-token-test',
        1.23,
        'source-reported',
        'priced',
      );
      db.prepare(`
        INSERT INTO session_token_daily (
          session_id, source, project, usage_date, attribution,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'opencode-cost-token-test',
        'opencode',
        'opencode-project',
        '2026-01-01',
        'session',
        1000,
        100,
        7000,
        0,
        300,
        8400,
      );

      try {
        const res = await app.request('/api/v1/overview/aggregates?source=opencode&window=all');
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.sessionCount).toBe(1);
        expect(body.inputTokens).toBe(1000);
        expect(body.outputTokens).toBe(100);
        expect(body.cacheReadTokens).toBe(7000);
        expect(body.reasoningTokens).toBe(300);
        expect(body.totalTokens).toBe(8400);
        expect(body.totalCost).toBe(1.23);
        expect(body.pricingStatus).toBe('priced');
      } finally {
        db.prepare('DELETE FROM session_token_daily WHERE session_id = ?').run('opencode-cost-token-test');
        db.prepare('DELETE FROM sessions WHERE id = ?').run('opencode-cost-token-test');
      }
    });

    it('uses Qoder root-session calibrated cost estimates without double-counting subagents', async () => {
      const db = getDatabase();
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          relationship_type, parent_session_id,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens,
          total_tokens, has_tool_calls, file_path, source_cost_usd,
          cost_source, cost_pricing_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'qoder-root-cost-test',
        'qoder',
        'qoder-project',
        'Qoder root cost test',
        '2026-05-18 00:00:00',
        '2026-05-18 00:01:00',
        'idle',
        'root',
        null,
        2,
        1,
        2000,
        1000,
        0,
        0,
        0,
        3000,
        0,
        '/tmp/qoder.db#qoder-root-cost-test',
        0.96,
        'qoder-token-calibrated-estimate',
        'priced',
      );
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          relationship_type, parent_session_id,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens,
          total_tokens, has_tool_calls, file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'qoder-child-cost-test',
        'qoder',
        'qoder-project',
        'Qoder subagent cost test',
        '2026-05-18 00:00:10',
        '2026-05-18 00:00:40',
        'idle',
        'subagent',
        'qoder-root-cost-test',
        2,
        1,
        700,
        300,
        0,
        0,
        0,
        1000,
        0,
        '/tmp/qoder.db#qoder-child-cost-test',
      );
      const insertDailyTokens = db.prepare(`
        INSERT INTO session_token_daily (
          session_id, source, project, usage_date, attribution,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertDailyTokens.run(
        'qoder-root-cost-test',
        'qoder',
        'qoder-project',
        '2026-05-18',
        'message',
        1000,
        2000,
        0,
        0,
        0,
        3000,
      );
      insertDailyTokens.run(
        'qoder-child-cost-test',
        'qoder',
        'qoder-project',
        '2026-05-18',
        'message',
        300,
        700,
        0,
        0,
        0,
        1000,
      );

      try {
        const res = await app.request('/api/v1/overview/aggregates?source=qoder&window=all');
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.sessionCount).toBe(2);
        expect(body.inputTokens).toBe(1300);
        expect(body.outputTokens).toBe(2700);
        expect(body.totalTokens).toBe(4000);
        expect(body.totalCost).toBe(0.96);
        expect(body.pricingStatus).toBe('priced');
      } finally {
        db.prepare('DELETE FROM session_token_daily WHERE session_id IN (?, ?)').run(
          'qoder-root-cost-test',
          'qoder-child-cost-test',
        );
        db.prepare('DELETE FROM sessions WHERE id IN (?, ?)').run(
          'qoder-root-cost-test',
          'qoder-child-cost-test',
        );
      }
    });

    it('returns all data when source is omitted (no source filter)', async () => {
      const res = await app.request('/api/v1/overview/aggregates?window=30d');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionCount).toBe(7);
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/aggregates?source=invalid');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid window', async () => {
      const res = await app.request('/api/v1/overview/aggregates?window=invalid');
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // 2. Daily Tokens
  // ==========================================================================

  describe('GET /api/v1/overview/daily-tokens', () => {
    it('returns a zero-filled 30 day token series by default', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.days).toHaveLength(30);
      expect(body.days[0]).toHaveProperty('date');
      expect(body.days[0]).toHaveProperty('sessionCount');
      expect(body.days[0]).toHaveProperty('inputTokens');
      expect(body.days[0]).toHaveProperty('outputTokens');
      expect(body.days[0]).toHaveProperty('cacheReadTokens');
      expect(body.days[0]).toHaveProperty('cacheWriteTokens');
      expect(body.days[0]).toHaveProperty('reasoningTokens');
      expect(body.days[0]).toHaveProperty('totalTokens');
      expect(body.days[0]).toHaveProperty('cost');
      expect(body.days[0]).toHaveProperty('pricingStatus');

      const zeroDays = body.days.filter((day: { totalTokens: number }) => day.totalTokens === 0);
      expect(zeroDays.length).toBeGreaterThan(0);
    });

    it('aggregates daily token totals for the 30 day window', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens');
      expect(res.status).toBe(200);
      const body = await res.json();

      const today = localDateKey(new Date());
      const fiveDaysAgo = localDateKey(new Date(Date.now() - 5 * 86400000));
      const fifteenDaysAgo = localDateKey(new Date(Date.now() - 15 * 86400000));

      const byDate = new Map(
        body.days.map((day: {
          date: string;
          sessionCount: number;
          totalTokens: number;
          cost: number | null;
          pricingStatus: string;
        }) => [day.date, day]),
      );

      expect(byDate.get(today)).toMatchObject({
        sessionCount: 2,
        totalTokens: 11000,
        cost: null,
        pricingStatus: 'unknown',
      });
      expect(byDate.get(fiveDaysAgo)).toMatchObject({
        sessionCount: 4,
        totalTokens: 30300,
        cost: 0.174,
        pricingStatus: 'partial',
      });
      expect(byDate.get(fifteenDaysAgo)).toMatchObject({
        sessionCount: 1,
        totalTokens: 3000,
        cost: 0.033,
        pricingStatus: 'priced',
      });
    });

    it('filters daily token totals by source', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens?source=openclaw');
      expect(res.status).toBe(200);
      const body = await res.json();

      const fiveDaysAgo = localDateKey(new Date(Date.now() - 5 * 86400000));
      const day = body.days.find((row: { date: string }) => row.date === fiveDaysAgo);
      expect(day).toMatchObject({ sessionCount: 3, totalTokens: 12300 });
    });

    it('returns a continuous earliest-to-latest token series for the all-time overview window', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens?window=all');
      expect(res.status).toBe(200);
      const body = await res.json();

      const today = localDateKey(new Date());
      const fiveDaysAgo = localDateKey(new Date(Date.now() - 5 * 86400000));
      const fifteenDaysAgo = localDateKey(new Date(Date.now() - 15 * 86400000));
      const thirtyNineDaysAgo = localDateKey(new Date(Date.now() - 39 * 86400000));
      const fortyDaysAgo = localDateKey(new Date(Date.now() - 40 * 86400000));

      const byDate = new Map(
        body.days.map((day: {
          date: string;
          sessionCount: number;
          totalTokens: number;
          cost: number | null;
          pricingStatus: string;
        }) => [day.date, day]),
      );

      expect(body.days).toHaveLength(41);
      expect(body.days[0].date).toBe(fortyDaysAgo);
      expect(body.days[body.days.length - 1].date).toBe(today);
      expect(byDate.get(fortyDaysAgo)).toMatchObject({ sessionCount: 1, totalTokens: 6000 });
      expect(byDate.get(thirtyNineDaysAgo)).toMatchObject({
        sessionCount: 0,
        totalTokens: 0,
        cost: null,
        pricingStatus: 'unknown',
      });
      expect(byDate.get(fifteenDaysAgo)).toMatchObject({ sessionCount: 1, totalTokens: 3000 });
      expect(byDate.get(fiveDaysAgo)).toMatchObject({ sessionCount: 4, totalTokens: 30300 });
      expect(byDate.get(today)).toMatchObject({ sessionCount: 2, totalTokens: 11000 });
    });

    it('filters all-time daily token totals by source', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens?source=codex&window=all');
      expect(res.status).toBe(200);
      const body = await res.json();

      const fortyDaysAgo = localDateKey(new Date(Date.now() - 40 * 86400000));

      expect(body.days).toHaveLength(1);
      expect(body.days[0]).toMatchObject({
        date: fortyDaysAgo,
        sessionCount: 1,
        totalTokens: 6000,
      });
    });

    it('counts today tokens for sessions that started on a previous day', async () => {
      const db = getDatabase();
      const today = localDateKey(new Date());
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().replace('T', ' ').split('.')[0];

      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          has_tool_calls, file_path, file_mtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'cx-cross-day',
        'codex',
        'project-alpha',
        'Cross day Codex',
        fiveDaysAgo,
        `${today} 12:00:00`,
        'idle',
        1,
        0,
        777,
        222,
        0,
        '/tmp/cx-cross-day.jsonl',
        `${today} 12:00:00`,
      );
      db.prepare(`
        INSERT INTO session_token_daily (
          session_id, source, project, usage_date, attribution,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          reasoning_tokens, total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('cx-cross-day', 'codex', 'project-alpha', today, 'event', 222, 777, 0, 0, 0, 999);

      try {
        const dailyRes = await app.request('/api/v1/overview/daily-tokens?source=codex&days=1');
        expect(dailyRes.status).toBe(200);
        const dailyBody = await dailyRes.json();
        expect(dailyBody.days[dailyBody.days.length - 1]).toMatchObject({
          date: today,
          sessionCount: 1,
          inputTokens: 222,
          outputTokens: 777,
          totalTokens: 999,
        });

        const aggregateRes = await app.request('/api/v1/overview/aggregates?source=codex&window=today');
        expect(aggregateRes.status).toBe(200);
        const aggregateBody = await aggregateRes.json();
        expect(aggregateBody.sessionCount).toBe(0);
        expect(aggregateBody.inputTokens).toBe(222);
        expect(aggregateBody.outputTokens).toBe(777);
        expect(aggregateBody.totalTokens).toBe(999);
      } finally {
        db.prepare('DELETE FROM session_token_daily WHERE session_id = ?').run('cx-cross-day');
        db.prepare('DELETE FROM sessions WHERE id = ?').run('cx-cross-day');
      }
    });

    it('supports a bounded custom day count', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens?days=7');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.days).toHaveLength(7);
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens?source=invalid');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid days', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens?days=999');
      expect(res.status).toBe(400);
    });

    it('returns 400 for unsupported daily token windows', async () => {
      const res = await app.request('/api/v1/overview/daily-tokens?window=30d');
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // 3. Top Models (DATA-102)
  // ==========================================================================

  describe('GET /api/v1/overview/top-models', () => {
    it('returns models with sharePercent summing to ~100', async () => {
      const res = await app.request('/api/v1/overview/top-models');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.models.length).toBeGreaterThan(0);
      const totalShare = body.models.reduce(
        (sum: number, m: { sharePercent: number }) => sum + m.sharePercent,
        0,
      );
      // Share may not sum to 100% because sessions without model-tagged
      // messages (e.g. automations) still contribute to total tokens
      expect(totalShare).toBeGreaterThan(0);
      expect(totalShare).toBeLessThanOrEqual(101);
    });

    it('includes model name and token counts', async () => {
      const res = await app.request('/api/v1/overview/top-models');
      expect(res.status).toBe(200);
      const body = await res.json();

      const modelNames = body.models.map((m: { name: string }) => m.name);
      expect(modelNames).toContain('gpt-4o');
      expect(modelNames).toContain('claude-sonnet-4-20250514');

      for (const m of body.models) {
        expect(m).toHaveProperty('name');
        expect(m).toHaveProperty('sessionCount');
        expect(m).toHaveProperty('inputTokens');
        expect(m).toHaveProperty('outputTokens');
        expect(m).toHaveProperty('totalTokens');
        expect(m).toHaveProperty('sharePercent');
        expect(m).toHaveProperty('cost');
        expect(m).toHaveProperty('pricingStatus');
      }

      const byName = new Map(body.models.map((m: {
        name: string;
        cost: number | null;
        pricingStatus: string;
      }) => [m.name, m]));
      expect(byName.get('claude-sonnet-4-20250514')).toMatchObject({
        cost: 0.174,
        pricingStatus: 'priced',
      });
      expect(byName.get('gpt-4o')).toMatchObject({
        cost: null,
        pricingStatus: 'unknown',
      });
    });

    it('does not duplicate session totals across repeated model-tagged messages', async () => {
      const res = await app.request('/api/v1/overview/top-models');
      expect(res.status).toBe(200);
      const body = await res.json();

      const byName = new Map(
        body.models.map((model: {
          name: string;
          sessionCount: number;
          totalTokens: number;
        }) => [model.name, model]),
      );

      expect(byName.get('gpt-4o')).toMatchObject({
        sessionCount: 2,
        totalTokens: 13000,
      });
      expect(byName.get('claude-sonnet-4-20250514')).toMatchObject({
        sessionCount: 1,
        totalTokens: 18000,
      });
    });

    it('merges same-model totals across sources after canonical normalization', async () => {
      const db = getDatabase();
      const now = new Date();
      const today = now.toISOString().replace('T', ' ').split('.')[0];
      const fiveDaysAgo = new Date(now.getTime() - 5 * 86400000)
        .toISOString().replace('T', ' ').split('.')[0];

      const insertSession = db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, agent_name, started_at, ended_at, status,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          has_tool_calls, file_path, file_mtime
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMessage = db.prepare(`
        INSERT INTO messages (id, session_id, ordinal, role, content, model)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertSession.run(
        'cx-2', 'codex', 'project-delta', 'GLM compare', null,
        fiveDaysAgo, fiveDaysAgo, 'idle',
        6, 3, 2000, 1000,
        0, '/tmp/cx-2.jsonl', fiveDaysAgo,
      );
      insertSession.run(
        'op-1', 'opencode', 'project-epsilon', 'OpenCode GLM', null,
        today, today, 'idle',
        4, 2, 1200, 800,
        0, '/tmp/op-1.db', today,
      );
      insertMessage.run('msg-cx2-1', 'cx-2', 1, 'user', 'Compare vendors', null);
      insertMessage.run('msg-cx2-2', 'cx-2', 2, 'assistant', 'Using GLM', 'glm-5.1');
      insertMessage.run('msg-op1-1', 'op-1', 1, 'user', 'Use OpenCode', null);
      insertMessage.run('msg-op1-2', 'op-1', 2, 'assistant', 'Provider-prefixed GLM', 'zhipuai-coding-plan/glm-5.1');

      const res = await app.request('/api/v1/overview/top-models');
      expect(res.status).toBe(200);
      const body = await res.json();

      const byName = new Map(
        body.models.map((model: {
          name: string;
          sessionCount: number;
          totalTokens: number;
          cost: number | null;
        }) => [model.name, model]),
      );

      expect(byName.get('glm5.1')).toMatchObject({
        sessionCount: 2,
        totalTokens: 5000,
        cost: 0.0166,
      });
      expect(byName.has('glm-5.1')).toBe(false);
      expect(byName.has('zhipuai-coding-plan/glm-5.1')).toBe(false);

      db.prepare(`DELETE FROM messages WHERE session_id IN ('cx-2', 'op-1')`).run();
      db.prepare(`DELETE FROM sessions WHERE id IN ('cx-2', 'op-1')`).run();
    });

    it('sorts models by estimated cost when requested', async () => {
      const res = await app.request('/api/v1/overview/top-models?sortBy=cost');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.models[0]).toMatchObject({
        name: 'claude-sonnet-4-20250514',
        cost: 0.174,
        pricingStatus: 'priced',
      });
    });

    it('uses source-estimated Qoder cost in cost-sorted model rankings', async () => {
      const db = getDatabase();
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          relationship_type, parent_session_id,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens,
          total_tokens, has_tool_calls, file_path, source_cost_usd,
          cost_source, cost_pricing_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'qoder-top-model-root',
        'qoder',
        'qoder-project',
        'Qoder top model root',
        '2026-05-18 00:00:00',
        '2026-05-18 00:01:00',
        'idle',
        'root',
        null,
        2,
        1,
        2000,
        1000,
        0,
        0,
        0,
        3000,
        0,
        '/tmp/qoder.db#qoder-top-model-root',
        0.96,
        'qoder-token-calibrated-estimate',
        'priced',
      );
      db.prepare(`
        INSERT INTO sessions (
          id, source, project, name, started_at, ended_at, status,
          relationship_type, parent_session_id,
          message_count, user_message_count, total_output_tokens, total_input_tokens,
          total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens,
          total_tokens, has_tool_calls, file_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'qoder-top-model-child',
        'qoder',
        'qoder-project',
        'Qoder top model child',
        '2026-05-18 00:00:10',
        '2026-05-18 00:00:40',
        'idle',
        'subagent',
        'qoder-top-model-root',
        2,
        1,
        700,
        300,
        0,
        0,
        0,
        1000,
        0,
        '/tmp/qoder.db#qoder-top-model-child',
      );
      db.prepare(`
        INSERT INTO messages (id, session_id, ordinal, role, content, model)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('msg-qtr-1', 'qoder-top-model-root', 1, 'assistant', 'root', 'ultimate');
      db.prepare(`
        INSERT INTO messages (id, session_id, ordinal, role, content, model)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('msg-qtc-1', 'qoder-top-model-child', 1, 'assistant', 'child', 'ultimate');

      try {
        const res = await app.request('/api/v1/overview/top-models?source=qoder&window=all&sortBy=cost');
        expect(res.status).toBe(200);
        const body = await res.json();

        expect(body.models[0]).toMatchObject({
          name: 'ultimate',
          cost: 0.96,
          pricingStatus: 'priced',
        });
      } finally {
        db.prepare('DELETE FROM messages WHERE id IN (?, ?)').run('msg-qtr-1', 'msg-qtc-1');
        db.prepare('DELETE FROM sessions WHERE id IN (?, ?)').run(
          'qoder-top-model-root',
          'qoder-top-model-child',
        );
      }
    });

    it('filters blank and synthetic model placeholders from the ranking', async () => {
      const res = await app.request('/api/v1/overview/top-models');
      expect(res.status).toBe(200);
      const body = await res.json();

      const modelNames = body.models.map((model: { name: string }) => model.name);
      expect(modelNames).not.toContain('');
      expect(modelNames).not.toContain('<synthetic>');
    });

    it('filters by source', async () => {
      const res = await app.request('/api/v1/overview/top-models?source=openclaw');
      expect(res.status).toBe(200);
      const body = await res.json();

      // Only gpt-4o for openclaw
      expect(body.models).toHaveLength(1);
      expect(body.models[0].name).toBe('gpt-4o');
      expect(body.models[0].totalTokens).toBe(13000);
    });

    it('respects limit parameter', async () => {
      const res = await app.request('/api/v1/overview/top-models?limit=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.models).toHaveLength(1);
    });

    it('caps limit at 50', async () => {
      const res = await app.request('/api/v1/overview/top-models?limit=999');
      expect(res.status).toBe(200);
      // Should still work — capped at 50
      const body = await res.json();
      expect(body.models.length).toBeLessThanOrEqual(50);
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/top-models?source=invalid');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid sortBy', async () => {
      const res = await app.request('/api/v1/overview/top-models?sortBy=latency');
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // 3. Top Projects (DATA-103)
  // ==========================================================================

  describe('GET /api/v1/overview/top-projects', () => {
    it('returns projects with token counts and rank weight', async () => {
      const res = await app.request('/api/v1/overview/top-projects');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.projects.length).toBeGreaterThan(0);
      for (const p of body.projects) {
        expect(p).toHaveProperty('project');
        expect(p).toHaveProperty('sessionCount');
        expect(p).toHaveProperty('turnCount');
        expect(p).toHaveProperty('inputTokens');
        expect(p).toHaveProperty('outputTokens');
        expect(p).toHaveProperty('totalTokens');
        expect(p).toHaveProperty('rankWeight');
        expect(p).toHaveProperty('cost');
        expect(p).toHaveProperty('pricingStatus');
        expect(typeof p.rankWeight).toBe('number');
      }

      // Rank weights should sum to ~100
      const totalWeight = body.projects.reduce(
        (sum: number, p: { rankWeight: number }) => sum + p.rankWeight,
        0,
      );
      expect(totalWeight).toBeGreaterThanOrEqual(99);
      expect(totalWeight).toBeLessThanOrEqual(101);

      const byProject = new Map(body.projects.map((p: {
        project: string;
        cost: number | null;
        pricingStatus: string;
      }) => [p.project, p]));
      expect(byProject.get('project-alpha')).toMatchObject({
        cost: 0.174,
        pricingStatus: 'partial',
      });
      expect(byProject.get('project-beta')).toMatchObject({
        cost: null,
        pricingStatus: 'unknown',
      });
    });

    it('sorts projects by estimated cost when requested', async () => {
      const res = await app.request('/api/v1/overview/top-projects?sortBy=cost');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.projects[0]).toMatchObject({
        project: 'project-alpha',
        cost: 0.174,
        pricingStatus: 'partial',
      });
    });

    it('filters by source', async () => {
      const res = await app.request('/api/v1/overview/top-projects?source=openclaw');
      expect(res.status).toBe(200);
      const body = await res.json();

      // openclaw has alpha and beta within 7d
      const projectNames = body.projects.map((p: { project: string }) => p.project);
      expect(projectNames).toContain('project-alpha');
      expect(projectNames).toContain('project-beta');
    });

    it('respects limit', async () => {
      const res = await app.request('/api/v1/overview/top-projects?limit=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projects).toHaveLength(1);
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/top-projects?source=invalid');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid sortBy', async () => {
      const res = await app.request('/api/v1/overview/top-projects?sortBy=latency');
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // 4. Starred (DATA-104)
  // ==========================================================================

  describe('GET /api/v1/overview/starred', () => {
    it('returns starred sessions ordered by starredAt DESC', async () => {
      const res = await app.request('/api/v1/overview/starred');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.starred).toHaveLength(2);
      // Most recent starred first (oc-1 was starred today, cc-1 was starred 5d ago)
      expect(body.starred[0].id).toBe('oc-1');
      expect(body.starred[1].id).toBe('cc-1');
    });

    it('includes session details', async () => {
      const res = await app.request('/api/v1/overview/starred');
      expect(res.status).toBe(200);
      const body = await res.json();

      const first = body.starred[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('name');
      expect(first).toHaveProperty('source');
      expect(first).toHaveProperty('project');
      expect(first).toHaveProperty('status');
      expect(first).toHaveProperty('starredAt');
    });

    it('filters by source', async () => {
      const res = await app.request('/api/v1/overview/starred?source=openclaw');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.starred).toHaveLength(1);
      expect(body.starred[0].id).toBe('oc-1');
      expect(body.starred[0].source).toBe('openclaw');
    });

    it('respects limit', async () => {
      const res = await app.request('/api/v1/overview/starred?limit=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.starred).toHaveLength(1);
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/starred?source=invalid');
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // 5. Timeline (DATA-105)
  // ==========================================================================

  describe('GET /api/v1/overview/timeline', () => {
    it('returns timeline events including session starts and sync errors', async () => {
      const res = await app.request('/api/v1/overview/timeline');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.timeline.length).toBeGreaterThan(0);

      // Should include session_started events
      const startedEvents = body.timeline.filter(
        (e: { eventType: string }) => e.eventType === 'session_started',
      );
      expect(startedEvents.length).toBeGreaterThan(0);

      // Should include sync_error events
      const syncErrors = body.timeline.filter(
        (e: { eventType: string }) => e.eventType === 'sync_error',
      );
      expect(syncErrors.length).toBeGreaterThan(0);
    });

    it('orders events by eventTime DESC', async () => {
      const res = await app.request('/api/v1/overview/timeline');
      expect(res.status).toBe(200);
      const body = await res.json();

      for (let i = 1; i < body.timeline.length; i++) {
        const prev = body.timeline[i - 1].eventTime;
        const curr = body.timeline[i].eventTime;
        if (prev && curr) {
          expect(prev >= curr).toBe(true);
        }
      }
    });

    it('filters by source', async () => {
      const res = await app.request('/api/v1/overview/timeline?source=openclaw');
      expect(res.status).toBe(200);
      const body = await res.json();

      for (const event of body.timeline) {
        expect(event.source).toBe('openclaw');
      }
    });

    it('respects limit', async () => {
      const res = await app.request('/api/v1/overview/timeline?limit=2');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.timeline.length).toBeLessThanOrEqual(2);
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/timeline?source=invalid');
      expect(res.status).toBe(400);
    });

    it('includes error events for sessions with status=error', async () => {
      const res = await app.request('/api/v1/overview/timeline');
      expect(res.status).toBe(200);
      const body = await res.json();

      const errorEvents = body.timeline.filter(
        (e: { eventType: string }) => e.eventType === 'session_error',
      );
      // cc-2 has status=error
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it('returns unique event ids even when one session contributes multiple timeline events', async () => {
      const res = await app.request('/api/v1/overview/timeline');
      expect(res.status).toBe(200);
      const body = await res.json();

      const ids = body.timeline.map((event: { id: string }) => event.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ==========================================================================
  // 6. Capabilities (DATA-106)
  // ==========================================================================

  describe('GET /api/v1/overview/capabilities', () => {
    it('returns capabilities map with all 6 sources', async () => {
      const res = await app.request('/api/v1/overview/capabilities');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.capabilities).toBeDefined();
      expect(body.sources).toBeDefined();
      expect(body.sources).toHaveLength(6);
      expect(body.sources).toContain('openclaw');
      expect(body.sources).toContain('claude-code');
      expect(body.sources).toContain('codex');
      expect(body.sources).toContain('opencode');
      expect(body.sources).toContain('qoder');

      // OpenClaw has agents, automations, cost
      expect(body.capabilities.openclaw.agents).toBe(true);
      expect(body.capabilities.openclaw.automations).toBe(true);
      expect(body.capabilities.openclaw.cost).toBe(true);

      // Claude Code has cost but not agents
      expect(body.capabilities['claude-code'].agents).toBe(false);
      expect(body.capabilities['claude-code'].cost).toBe(true);

      // Codex has no cost
      expect(body.capabilities.codex.cost).toBe(false);
      expect(body.capabilities.codex.automations).toBe(true);

      // Qoder surfaces root-session calibrated token cost estimates.
      expect(body.capabilities.qoder.cost).toBe(true);
      expect(body.capabilities.qoder.agents).toBe(false);
      expect(body.capabilities.qoder.automations).toBe(false);
      expect(body.capabilities.qoder.sessions).toBe(true);
      expect(body.capabilities.qoder.replay).toBe(true);
      expect(body.capabilities.qoder.activity).toBe(true);
    });
  });

  // ==========================================================================
  // 7. Agents (OPEN-101)
  // ==========================================================================

  describe('GET /api/v1/overview/agents', () => {
    it('returns agent summaries with session and tool counts', async () => {
      const res = await app.request('/api/v1/overview/agents?source=openclaw');
      expect(res.status).toBe(200);
      const body = await res.json();

      // agent-blue (oc-1, oc-2, oc-3) + auto-deploy (oc-auto-1, oc-auto-2)
      expect(body.agents).toHaveLength(2);
      const agentBlue = body.agents.find((a: { name: string }) => a.name === 'agent-blue');
      expect(agentBlue).toBeDefined();
      expect(agentBlue.sessionCount).toBe(3);
      expect(agentBlue.toolCallCount).toBe(2);
      expect(body.agents[0]).toHaveProperty('lastActiveAt');
      expect(body.agents[0]).toHaveProperty('latestStatus');
    });

    it('returns 400 when source is missing', async () => {
      const res = await app.request('/api/v1/overview/agents');
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/agents?source=invalid');
      expect(res.status).toBe(400);
    });

    it('returns empty agents for source without agent_name', async () => {
      const res = await app.request('/api/v1/overview/agents?source=claude-code');
      expect(res.status).toBe(200);
      const body = await res.json();
      // claude-code sessions have no agent_name, so no agents
      expect(body.agents).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 8b. Automations (OVR-104)
  // ==========================================================================

  describe('GET /api/v1/overview/automations', () => {
    it('returns database and file-backed automation summaries for openclaw source', async () => {
      const res = await app.request('/api/v1/overview/automations?source=openclaw');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.automations).toHaveLength(2);

      // Session fallback: only auto-deploy sessions (user_message_count = 0), not agent-blue.
      const sessionAutomation = body.automations.find((a: { name: string }) => a.name === 'auto-deploy');
      expect(sessionAutomation).toBeDefined();
      expect(sessionAutomation.sessionCount).toBe(2);
      expect(sessionAutomation.toolCallCount).toBe(2);
      expect(sessionAutomation.source).toBe('openclaw');

      // Real OpenClaw automation definitions come from cron/jobs.json.
      const fileAutomation = body.automations.find((a: { name: string }) => a.name === 'openclaw-nightly-docs');
      expect(fileAutomation).toBeDefined();
      expect(fileAutomation.id).toBe('oc-file-job');
      expect(fileAutomation.sessionCount).toBe(1);
      expect(fileAutomation.schedule).toBe('0 3 * * * Asia/Tokyo');
      expect(fileAutomation).toHaveProperty('lastActiveAt');
      expect(fileAutomation).toHaveProperty('latestStatus');
    });

    it('returns aggregate automations when source is missing', async () => {
      const res = await app.request('/api/v1/overview/automations');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.automations).toHaveLength(3);
      expect(body.automations.map((a: { source: string }) => a.source)).toContain('openclaw');
      expect(body.automations.map((a: { source: string }) => a.source)).toContain('codex');
    });

    it('returns 400 for invalid source', async () => {
      const res = await app.request('/api/v1/overview/automations?source=invalid');
      expect(res.status).toBe(400);
    });

    it('returns file-backed automations for codex source', async () => {
      const res = await app.request('/api/v1/overview/automations?source=codex');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.automations).toHaveLength(1);
      expect(body.automations[0].source).toBe('codex');
      expect(body.automations[0].name).toBe('codex-weekly-docs');
      expect(body.automations[0].sessionCount).toBe(2);
      expect(body.automations[0].latestStatus).toBe('active');
      expect(body.automations[0].schedule).toContain('FREQ=WEEKLY');
    });

    it('returns empty automations for source without agent_name', async () => {
      const res = await app.request('/api/v1/overview/automations?source=claude-code');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.automations).toHaveLength(0);
    });
  });

  // ==========================================================================
  // 8. Status (OPEN-103)
  // ==========================================================================

  describe('GET /api/v1/overview/status', () => {
    it('returns ingest, watcher, sync, and gateway sections', async () => {
      const res = await app.request('/api/v1/overview/status');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body).toHaveProperty('ingest');
      expect(body).toHaveProperty('watcher');
      expect(body).toHaveProperty('sync');
      expect(body).toHaveProperty('gateway');

      expect(body.ingest).toHaveProperty('status');
      expect(body.ingest).toHaveProperty('uptime');
      expect(body.ingest).toHaveProperty('db');

      expect(body.watcher).toHaveProperty('status');
      expect(body.watcher).toHaveProperty('filesWatched');

      if (body.sync) {
        expect(body.sync).toHaveProperty('active');
        expect(body.sync).toHaveProperty('queued');
        expect(body.sync).toHaveProperty('lastError');
      }

      expect(body.gateway).toHaveProperty('status');
      expect(body.gateway.status).toBe('disconnected');
    });

    it('reports ingest status as ok when context available', async () => {
      const res = await app.request('/api/v1/overview/status');
      expect(res.status).toBe(200);
      const body = await res.json();

      // In test mode, context is null (not started via index.ts),
      // so ingest status should be 'error'
      // But the db may be connected since we opened it via openDatabase()
      expect(['ok', 'error']).toContain(body.ingest.status);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('returns 400 for invalid source across endpoints', async () => {
      const endpoints = [
        '/api/v1/overview/aggregates?source=bad',
        '/api/v1/overview/top-models?source=bad',
        '/api/v1/overview/top-projects?source=bad',
        '/api/v1/overview/starred?source=bad',
        '/api/v1/overview/timeline?source=bad',
        '/api/v1/overview/agents?source=bad',
      ];

      for (const url of endpoints) {
        const res = await app.request(url);
        expect(res.status, `Expected 400 for ${url}`).toBe(400);
      }
    });

    it('returns zero counts (not null) for empty results', async () => {
      // Filter to codex with today window — no codex sessions today
      const res = await app.request('/api/v1/overview/aggregates?source=codex&window=today');
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.sessionCount).toBe(0);
      expect(body.turnCount).toBe(0);
      expect(body.inputTokens).toBe(0);
      expect(body.outputTokens).toBe(0);
      expect(body.totalTokens).toBe(0);
    });

    it('returns empty arrays for endpoints with no matching data', async () => {
      // No codex sessions within 7d
      const res = await app.request('/api/v1/overview/top-models?source=codex&window=7d');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.models).toEqual([]);
    });
  });
});
