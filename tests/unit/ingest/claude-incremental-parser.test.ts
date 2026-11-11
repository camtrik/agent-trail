import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseClaudeSessionAppend } from '@/ingest/parser/claude';
import type { IncrementalParseOptions } from '@/ingest/parser/types';

describe('Claude incremental parser', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-incremental-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses only appended Claude user and assistant lines', async () => {
    const historical = '{bad historical json}\n';
    const appended = [
      JSON.stringify(claudeLine('user-1', 'user', 'Hello')),
      JSON.stringify(claudeLine('assistant-1', 'assistant', 'Hi there')),
      '',
    ].join('\n');
    const filePath = writeJsonl('append.jsonl', historical + appended);

    const delta = await parseClaudeSessionAppend(filePath, 'project', {
      ...baseOptions(),
      startOffset: Buffer.byteLength(historical),
      endOffset: statSync(filePath).size,
      startLine: 1,
    });

    expect(delta.requiresFullReparse).toBeFalsy();
    expect(delta.errors).toEqual([]);
    expect(delta.messages.map((message) => message.content)).toEqual(['Hello', 'Hi there']);
    expect(delta.messages.map((message) => message.ordinal)).toEqual([0, 1]);
    expect(delta.cursorUpdate.lastIndexedLine).toBe(3);
  });

  it('does not parse or advance into a trailing partial Claude line', async () => {
    const complete = `${JSON.stringify(claudeLine('user-1', 'user', 'Complete'))}\n`;
    const partial = '{"uuid":"partial","type":"assistant","message":';
    const filePath = writeJsonl('partial.jsonl', complete + partial);

    const delta = await parseClaudeSessionAppend(filePath, 'project', {
      ...baseOptions(),
      endOffset: statSync(filePath).size,
    });

    expect(delta.messages).toHaveLength(1);
    expect(delta.messages[0].content).toBe('Complete');
    expect(delta.cursorUpdate.lastIndexedOffset).toBe(Buffer.byteLength(complete));
    expect(delta.cursorUpdate.lastIndexedLine).toBe(1);
  });

  it('does not use a lossy encoded Claude project fallback during append', async () => {
    const filePath = writeJsonl(
      'encoded-project-append.jsonl',
      `${JSON.stringify(claudeLine('assistant-1', 'assistant', 'No cwd here'))}\n`
    );

    const delta = await parseClaudeSessionAppend(
      filePath,
      '//Users/example/Work/ai/dashboard/projects',
      {
        ...baseOptions(),
        endOffset: statSync(filePath).size,
      }
    );

    expect(delta.sessionPatch.project).toBeUndefined();
  });

  it('promotes appended Claude cwd metadata to the session project', async () => {
    const cwd = '/Users/example/Work/ai-dashboard-projects/agents-tracing-dashboard';
    const filePath = writeJsonl(
      'cwd-append.jsonl',
      `${JSON.stringify({ ...claudeLine('assistant-1', 'assistant', 'Has cwd'), cwd })}\n`
    );

    const delta = await parseClaudeSessionAppend(filePath, 'default', {
      ...baseOptions(),
      endOffset: statSync(filePath).size,
    });

    expect(delta.sessionPatch.cwd).toBe(cwd);
    expect(delta.sessionPatch.project).toBe(cwd);
  });

  it('represents a Claude tool result for a known previous tool call', async () => {
    const line = JSON.stringify({
      uuid: 'tool-result-1',
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_known', content: 'done', is_error: false },
        ],
      },
      timestamp: '2026-05-15T00:00:00.000Z',
    });
    const filePath = writeJsonl('known-tool-result.jsonl', `${line}\n`);

    const delta = await parseClaudeSessionAppend(filePath, 'project', {
      ...baseOptions(),
      endOffset: statSync(filePath).size,
      startTurnIndex: 0,
      currentTurnId: 'turn-0',
      knownToolCallIds: ['toolu_known'],
    });

    expect(delta.requiresFullReparse).toBeFalsy();
    expect(delta.toolResultEvents).toHaveLength(1);
    expect(delta.toolResultEvents[0].toolId).toBe('toolu_known');
    expect(delta.toolResultEvents[0].event.content).toBe('done');
    expect(delta.messages[0].role).toBe('tool_result');
  });

  it('requests full reparse when a Claude append depends on missing tool context', async () => {
    const line = JSON.stringify({
      uuid: 'tool-result-missing',
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_missing', content: 'done', is_error: false },
        ],
      },
    });
    const filePath = writeJsonl('missing-tool-result.jsonl', `${line}\n`);

    const delta = await parseClaudeSessionAppend(filePath, 'project', {
      ...baseOptions(),
      endOffset: statSync(filePath).size,
      startTurnIndex: 0,
      currentTurnId: 'turn-0',
    });

    expect(delta.requiresFullReparse).toBe(true);
    expect(delta.fallbackReason).toBe('missing_tool_context');
  });

  function writeJsonl(name: string, content: string): string {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  it.each(['api-request-blob', 'api-request'])(
    'ignores appended %s snapshots of existing messages',
    async (snapshotType) => {
      const rows = readFileSync(
        join(process.cwd(), 'tests/fixtures/real-shape/claude/request-blob.jsonl'),
        'utf8'
      ).trim().split('\n').map((line) => JSON.parse(line));
      const history = rows.slice(0, 2).map((row) => JSON.stringify(row)).join('\n') + '\n';
      const appended = rows.slice(2).map((row) => JSON.stringify(
        row.type === 'api-request-blob' ? { ...row, type: snapshotType } : row
      )).join('\n') + '\n';
      const filePath = writeJsonl('request-snapshot.jsonl', history + appended);

      const delta = await parseClaudeSessionAppend(filePath, 'fixture', {
        ...baseOptions(),
        startOffset: Buffer.byteLength(history),
        endOffset: statSync(filePath).size,
        startLine: 2,
        startOrdinal: 2,
        startTurnIndex: 0,
        currentTurnId: 'turn-0',
        knownToolCallIds: ['toolu_rs02'],
      });

      expect(delta.requiresFullReparse).toBeFalsy();
      expect(delta.errors).toEqual([]);
      expect(delta.toolCalls).toEqual([]);
      expect(delta.messages).toHaveLength(1);
      expect(delta.messages[0].role).toBe('tool_result');
      expect(delta.toolResultEvents).toHaveLength(1);
      expect(delta.cursorUpdate.lastIndexedLine).toBe(5);
    }
  );

  function baseOptions(): IncrementalParseOptions {
    return {
      startOffset: 0,
      endOffset: 0,
      startLine: 0,
      startOrdinal: 0,
      startTurnIndex: -1,
      parserVersion: 'test-parser',
    };
  }

  function claudeLine(uuid: string, role: 'user' | 'assistant', content: string) {
    return {
      uuid,
      type: role,
      message: { role, content },
      timestamp: '2026-05-15T00:00:00.000Z',
    };
  }
});
