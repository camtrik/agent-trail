/**
 * Turn Activity Regression Tests
 *
 * Verifies that assembleTurns() reads persisted tool calls and result events
 * from SQLite and produces structured TraceToolCall activities on turns.
 *
 * These tests catch the regression where tool activities were only in parser
 * memory state and never surfaced in the DB-backed turn model.
 *
 * @group ingest/turns
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  appendSessionDeltaToDatabase,
  PARSER_CACHE_VERSION,
  writeSessionToDatabase,
} from '@/ingest/sync/index';
import type { IncrementalParseDelta, ParseResult } from '@/ingest/parser/types';
import type { CursorDecision } from '@/ingest/sync';
import type { TraceSubagentLink, TraceToolCall, TraceToolResultEvent } from '@/types/trace';

// ============================================================================
// Helpers
// ============================================================================

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  const schemaPath = join(process.cwd(), 'ingest', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

function makeParseResultWithTools(
  sessionId: string,
  toolCalls: Partial<TraceToolCall>[],
  messageCount = 2
): ParseResult {
  const messages: ParseResult['messages'] = Array.from({ length: messageCount }, (_, i) => ({
    id: `${sessionId}:${i}`,
    ordinal: i,
    role: i === 0 ? 'user' : 'assistant',
    content: i === 0 ? 'Run the command' : 'Running...',
    timestamp: `2024-01-01T00:0${i}:00Z`,
    sourceMetadata: {
      sourceType: 'claude-code',
      sourceFile: '/fake/session.jsonl',
      sourceLine: i + 1,
    },
  }));

  const activities: TraceToolCall[] = toolCalls.map((tc, i) => ({
    type: 'tool_call' as const,
    id: tc.id ?? `toolu_${i}`,
    name: tc.name ?? 'Bash',
    category: tc.category ?? 'Bash',
    inputJson: tc.inputJson ?? '{}',
    resultEvents: tc.resultEvents ?? [],
    status: tc.status ?? 'success',
    messageOrdinal: tc.messageOrdinal ?? 1,
    sourceLine: tc.sourceLine ?? 1,
  }));

  return {
    session: {
      id: sessionId,
      source: 'claude-code',
      project: 'test-project',
      name: 'Test',
      startedAt: '2024-01-01T00:00:00Z',
      endedAt: '2024-01-01T01:00:00Z',
      status: 'idle',
      metrics: {
        messageCount,
        userMessageCount: 1,
        totalTokens: 50,
        hasToolCalls: toolCalls.length > 0,
        parserMalformedLines: 0,
        isTruncated: false,
      },
      turns: [],
    },
    messages,
    activities,
    errors: [],
    warnings: [],
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('turn activity regression — assembleTurns reads tool activities from DB', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('turn.activities contains persisted tool call after sync', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-tool-activity-001';

    const parseResult = makeParseResultWithTools(sessionId, [
      {
        id: 'toolu_regression01',
        name: 'Bash',
        category: 'Bash',
        inputJson: JSON.stringify({ command: 'echo hello' }),
        resultEvents: [
          { type: 'result_event', content: 'hello', isPartial: false } as TraceToolResultEvent,
        ],
        status: 'success',
        messageOrdinal: 1,
      },
    ]);

    const syncResult = writeSessionToDatabase(parseResult, db);
    expect(syncResult.errors).toEqual([]);
    expect(syncResult.toolCallsInserted).toBe(1);
    expect(syncResult.toolResultEventsInserted).toBe(1);

    const turns = await assembleTurns(sessionId, db);

    expect(turns.length).toBeGreaterThan(0);
    const turn0 = turns[0];
    const toolActivities = turn0.activities.filter(a => a.type === 'tool_call');

    expect(toolActivities.length).toBe(1);
    const toolCall = toolActivities[0] as TraceToolCall;
    expect(toolCall.id).toBe('toolu_regression01');
    expect(toolCall.name).toBe('Bash');
    expect(toolCall.status).toBe('success');
  });

  it('tool call result events are surfaced in turn activities', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-tool-result-events-001';

    const parseResult = makeParseResultWithTools(sessionId, [
      {
        id: 'toolu_with_results',
        name: 'Read',
        category: 'Read',
        inputJson: JSON.stringify({ file_path: '/foo/bar.ts' }),
        resultEvents: [
          { type: 'result_event', content: 'line1\nline2', isPartial: false } as TraceToolResultEvent,
          { type: 'result_event', content: 'more content', isPartial: false } as TraceToolResultEvent,
        ],
        status: 'success',
        messageOrdinal: 1,
      },
    ]);

    writeSessionToDatabase(parseResult, db);

    const turns = await assembleTurns(sessionId, db);
    const turn0 = turns[0];
    const toolCall = turn0.activities.find(a => a.type === 'tool_call') as TraceToolCall | undefined;

    expect(toolCall).toBeDefined();
    expect(toolCall!.resultEvents.length).toBe(2);
    expect(toolCall!.resultEvents[0].content).toBe('line1\nline2');
    expect(toolCall!.resultEvents[1].content).toBe('more content');
  });

  it('multiple tool calls in same turn are all surfaced', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-multi-tool-001';

    const parseResult = makeParseResultWithTools(sessionId, [
      { id: 'tc_read', name: 'Read', category: 'Read', inputJson: '{"file_path":"/a.ts"}', resultEvents: [], status: 'success', messageOrdinal: 1 },
      { id: 'tc_bash', name: 'Bash', category: 'Bash', inputJson: '{"command":"ls"}', resultEvents: [{ type: 'result_event', content: 'a.ts', isPartial: false } as TraceToolResultEvent], status: 'success', messageOrdinal: 1 },
    ]);

    writeSessionToDatabase(parseResult, db);

    const turns = await assembleTurns(sessionId, db);
    const turn0 = turns[0];
    const toolActivities = turn0.activities.filter(a => a.type === 'tool_call');

    expect(toolActivities.length).toBe(2);
    const names = toolActivities.map(a => (a as TraceToolCall).name).sort();
    expect(names).toEqual(['Bash', 'Read']);
  });

  it('turn with no tool calls has empty tool activities', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-no-tools-001';

    const parseResult = makeParseResultWithTools(sessionId, []); // no tool calls
    writeSessionToDatabase(parseResult, db);

    const turns = await assembleTurns(sessionId, db);

    if (turns.length > 0) {
      const toolActivities = turns[0].activities.filter(a => a.type === 'tool_call');
      expect(toolActivities.length).toBe(0);
    }
  });

  it('tool call category is preserved from DB', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-category-check';

    const parseResult = makeParseResultWithTools(sessionId, [
      { id: 'tc_grep', name: 'Grep', category: 'Grep', inputJson: '{"pattern":"foo"}', resultEvents: [], status: 'success', messageOrdinal: 1 },
    ]);

    writeSessionToDatabase(parseResult, db);

    const turns = await assembleTurns(sessionId, db);
    const tool = turns[0].activities.find(a => a.type === 'tool_call') as TraceToolCall;

    expect(tool).toBeDefined();
    expect(tool.category).toBe('Grep');
  });

  it('force re-sync replaces tool activities with new parser output', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-force-resync-activities';

    // First sync: 2 tool calls
    const initial = makeParseResultWithTools(sessionId, [
      { id: 'tc_old1', name: 'Bash', category: 'Bash', inputJson: '{}', resultEvents: [], status: 'pending', messageOrdinal: 1 },
      { id: 'tc_old2', name: 'Read', category: 'Read', inputJson: '{}', resultEvents: [], status: 'pending', messageOrdinal: 1 },
    ]);
    writeSessionToDatabase(initial, db);

    // Verify 2 tool activities
    const turnsFirst = await assembleTurns(sessionId, db);
    const toolsFirst = turnsFirst[0]?.activities.filter(a => a.type === 'tool_call') ?? [];
    expect(toolsFirst.length).toBe(2);

    // Second sync with force=true and only 1 tool call
    const updated = makeParseResultWithTools(sessionId, [
      { id: 'tc_new', name: 'Grep', category: 'Grep', inputJson: '{"pattern":"x"}', resultEvents: [{ type: 'result_event', content: 'match', isPartial: false } as TraceToolResultEvent], status: 'success', messageOrdinal: 1 },
    ]);
    writeSessionToDatabase(updated, db, undefined, { force: true });

    // Verify 1 tool activity (stale rows removed)
    const turnsSecond = await assembleTurns(sessionId, db);
    const toolsSecond = turnsSecond[0]?.activities.filter(a => a.type === 'tool_call') ?? [];
    expect(toolsSecond.length).toBe(1);
    expect((toolsSecond[0] as TraceToolCall).name).toBe('Grep');
  });

  it('turn.activities contains persisted subagent links after sync', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-subagent-link-activity-001';

    const toolCall: TraceToolCall = {
      type: 'tool_call',
      id: 'call_spawn_001',
      name: 'spawn_agent',
      category: 'Agent',
      inputJson: '{"task":"inspect parser"}',
      resultEvents: [],
      status: 'success',
      messageOrdinal: 1,
    };
    const subagentLink: TraceSubagentLink = {
      type: 'subagent_link',
      subagentSessionId: 'child-thread-001',
      subagentSource: 'codex',
      relationship: 'spawned',
      messageOrdinal: 1,
    };

    const parseResult: ParseResult = {
      session: {
        id: sessionId,
        source: 'codex',
        project: 'test-project',
        name: 'Test',
        startedAt: '2024-01-01T00:00:00Z',
        endedAt: '2024-01-01T01:00:00Z',
        status: 'idle',
        metrics: {
          messageCount: 2,
          userMessageCount: 1,
          totalTokens: 50,
          hasToolCalls: true,
          parserMalformedLines: 0,
          isTruncated: false,
        },
        turns: [],
      },
      messages: [
        {
          id: `${sessionId}:0`,
          ordinal: 0,
          role: 'user',
          content: 'Spawn a helper',
          sourceMetadata: { sourceType: 'codex', sourceFile: '/fake/session.jsonl', sourceLine: 1 },
        },
        {
          id: `${sessionId}:1`,
          ordinal: 1,
          role: 'assistant',
          content: '',
          sourceMetadata: { sourceType: 'codex', sourceFile: '/fake/session.jsonl', sourceLine: 2 },
        },
      ],
      activities: [toolCall, subagentLink],
      errors: [],
      warnings: [],
    };

    const syncResult = writeSessionToDatabase(parseResult, db);
    expect(syncResult.errors).toEqual([]);

    const turns = await assembleTurns(sessionId, db);
    const subagentActivities = turns.flatMap((turn) =>
      turn.activities.filter((activity) => activity.type === 'subagent_link')
    ) as TraceSubagentLink[];

    expect(subagentActivities).toHaveLength(1);
    expect(subagentActivities[0].subagentSessionId).toBe('child-thread-001');
    expect(subagentActivities[0].messageOrdinal).toBe(1);
    expect(turns[0].activities.map((activity) => activity.type)).toContain('tool_call');
  });

  it('places persisted subagent links next to their owning tool call ordinal', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-subagent-link-order-001';

    const parseResult: ParseResult = {
      session: {
        id: sessionId,
        source: 'codex',
        project: 'test-project',
        name: 'Test',
        startedAt: '2024-01-01T00:00:00Z',
        endedAt: '2024-01-01T01:00:00Z',
        status: 'idle',
        metrics: {
          messageCount: 4,
          userMessageCount: 1,
          totalTokens: 50,
          hasToolCalls: true,
          parserMalformedLines: 0,
          isTruncated: false,
        },
        turns: [],
      },
      messages: [
        { id: `${sessionId}:0`, ordinal: 0, role: 'user', content: 'Spawn helper', sourceMetadata: { sourceType: 'codex', sourceFile: '/fake/session.jsonl', sourceLine: 1 } },
        { id: `${sessionId}:1`, ordinal: 1, role: 'assistant', content: '', sourceMetadata: { sourceType: 'codex', sourceFile: '/fake/session.jsonl', sourceLine: 2 } },
        { id: `${sessionId}:2`, ordinal: 2, role: 'assistant', content: 'Still working', sourceMetadata: { sourceType: 'codex', sourceFile: '/fake/session.jsonl', sourceLine: 3 } },
        { id: `${sessionId}:3`, ordinal: 3, role: 'assistant', content: '', sourceMetadata: { sourceType: 'codex', sourceFile: '/fake/session.jsonl', sourceLine: 4 } },
      ],
      activities: [
        { type: 'tool_call', id: 'call_spawn', name: 'spawn_agent', category: 'Agent', inputJson: '{}', resultEvents: [], status: 'success', messageOrdinal: 1 } as TraceToolCall,
        { type: 'tool_call', id: 'call_read', name: 'read_file', category: 'Read', inputJson: '{}', resultEvents: [], status: 'success', messageOrdinal: 3 } as TraceToolCall,
        { type: 'subagent_link', subagentSessionId: 'child-thread-ordered', subagentSource: 'codex', relationship: 'spawned', messageOrdinal: 1 } as TraceSubagentLink,
      ],
      errors: [],
      warnings: [],
    };

    const syncResult = writeSessionToDatabase(parseResult, db);
    expect(syncResult.errors).toEqual([]);

    const turns = await assembleTurns(sessionId, db);
    const keyedActivities = turns[0].activities
      .filter((activity) => activity.type === 'tool_call' || activity.type === 'subagent_link')
      .map((activity) => {
        if (activity.type === 'tool_call') return `tool:${activity.id}`;
        return `subagent:${activity.subagentSessionId}`;
      });

    expect(keyedActivities).toEqual([
      'tool:call_spawn',
      'subagent:child-thread-ordered',
      'tool:call_read',
    ]);
  });

  it('tool_result-only messages do not create spurious turns', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-tool-result-role';

    // Simulate a parse result where the tool result message has role=tool_result
    const parseResult: ParseResult = {
      session: {
        id: sessionId,
        source: 'claude-code',
        project: 'test',
        name: 'Test',
        startedAt: '2024-01-01T00:00:00Z',
        endedAt: '2024-01-01T01:00:00Z',
        status: 'idle',
        metrics: { messageCount: 3, userMessageCount: 1, hasToolCalls: true, parserMalformedLines: 0, isTruncated: false },
        turns: [],
      },
      messages: [
        { id: `${sessionId}:0`, ordinal: 0, role: 'user', content: 'Run ls', sourceMetadata: { sourceType: 'claude-code', sourceFile: '/f.jsonl', sourceLine: 1 } },
        { id: `${sessionId}:1`, ordinal: 1, role: 'assistant', content: 'Running...', sourceMetadata: { sourceType: 'claude-code', sourceFile: '/f.jsonl', sourceLine: 2 } },
        { id: `${sessionId}:2`, ordinal: 2, role: 'tool_result', content: 'file1.ts', sourceMetadata: { sourceType: 'claude-code', sourceFile: '/f.jsonl', sourceLine: 3 } },
      ],
      activities: [
        { type: 'tool_call', id: 'toolu_ls', name: 'Bash', category: 'Bash', inputJson: '{"command":"ls"}', resultEvents: [{ type: 'result_event', content: 'file1.ts', isPartial: false }], status: 'success', messageOrdinal: 1 } as TraceToolCall,
      ],
      errors: [],
      warnings: [],
    };

    writeSessionToDatabase(parseResult, db);

    const turns = await assembleTurns(sessionId, db);

    // Should produce exactly 1 turn (user msg at ordinal 0 starts it)
    // The tool_result message should not create a new turn
    expect(turns.length).toBe(1);
    expect(turns[0].userMessage?.content).toBe('Run ls');
  });

  it('assembleTurns sees append-written messages, result events, and subagent links', async () => {
    const { assembleTurns } = await import('@/ingest/turns/assembler');
    const sessionId = 'sess-append-assembled';
    const sourceFile = '/fake/append-session.jsonl';

    writeSessionToDatabase({
      session: {
        id: sessionId,
        source: 'codex',
        project: 'test',
        startedAt: '2026-05-15T00:00:00Z',
        endedAt: '2026-05-15T00:00:01Z',
        status: 'idle',
        metrics: { messageCount: 1, userMessageCount: 1, hasToolCalls: false, parserMalformedLines: 0, isTruncated: false },
        turns: [],
      },
      messages: [
        { id: `${sessionId}:0`, ordinal: 0, role: 'user', content: 'seed', turnId: 'turn-0', turnIndex: 0, isRealUserInput: true, sourceMetadata: { sourceType: 'codex', sourceFile, sourceLine: 1 } },
      ],
      activities: [],
      errors: [],
      warnings: [],
    }, db);

    const delta: IncrementalParseDelta = {
      sessionId,
      sourceType: 'codex',
      messages: [
        { id: `${sessionId}:1`, ordinal: 1, role: 'user', content: 'spawn helper', turnId: 'turn-1', turnIndex: 1, isRealUserInput: true, sourceMetadata: { sourceType: 'codex', sourceFile, sourceLine: 2 } },
        { id: `${sessionId}:2`, ordinal: 2, role: 'assistant', content: '', turnId: 'turn-1', turnIndex: 1, isRealUserInput: false, sourceMetadata: { sourceType: 'codex', sourceFile, sourceLine: 3 } },
      ],
      toolCalls: [
        { type: 'tool_call', id: 'call-append-assemble', name: 'spawn_agent', category: 'Agent', inputJson: '{}', resultEvents: [{ type: 'result_event', content: 'child ready', isPartial: false }], status: 'success', messageOrdinal: 2 },
      ],
      toolResultEvents: [],
      subagentLinks: [
        { type: 'subagent_link', subagentSessionId: 'child-append-assembled', subagentSource: 'codex', relationship: 'spawned', messageOrdinal: 2 },
      ],
      sessionPatch: { project: 'test', status: 'idle' },
      metricsDelta: { messageCount: 2, userMessageCount: 1, totalInputTokens: 0, totalOutputTokens: 0, hasToolCalls: true, parserMalformedLines: 0 },
      cursorUpdate: { lastIndexedOffset: 32, lastIndexedLine: 2, lastMessageOrdinal: 2, lastTurnIndex: 1 },
      errors: [],
      warnings: [],
    };
    const decision: Extract<CursorDecision, { type: 'incremental_append' }> = {
      type: 'incremental_append',
      cursor: {
        sourceType: 'codex',
        filePath: sourceFile,
        sessionId,
        fileSize: 16,
        fileMtime: '2026-05-15T00:00:00.000Z',
        fileInode: 1,
        fileDevice: 1,
        parserVersion: PARSER_CACHE_VERSION,
        lastIndexedOffset: 16,
        lastIndexedLine: 1,
        lastMessageOrdinal: 0,
        lastTurnIndex: 0,
        lastSuccessAt: null,
        lastFallbackReason: null,
      },
      snapshot: { size: 32, mtimeIso: '2026-05-15T00:00:01.000Z', inode: 1, device: 1 },
      startOffset: 16,
      endOffset: 32,
      startLine: 1,
      startOrdinal: 1,
      startTurnIndex: 0,
    };

    const appendResult = appendSessionDeltaToDatabase(delta, db, sourceFile, decision);
    expect(appendResult.errors).toEqual([]);

    const turns = await assembleTurns(sessionId, db);
    const appendedTurn = turns.find((turn) => turn.userMessage?.content === 'spawn helper');
    expect(appendedTurn).toBeDefined();
    const tool = appendedTurn?.activities.find((activity) => activity.type === 'tool_call') as TraceToolCall | undefined;
    const subagent = appendedTurn?.activities.find((activity) => activity.type === 'subagent_link') as TraceSubagentLink | undefined;

    expect(tool?.resultEvents[0].content).toBe('child ready');
    expect(subagent?.subagentSessionId).toBe('child-append-assembled');
  });
});
