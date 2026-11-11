import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

// We will import assembleTurns after it's made async
// For now, dynamically import or reference the function
// The tests are written for the async version

/**
 * Helper: Create an in-memory SQLite database with full schema
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Load schema from file
  const schemaPath = join(process.cwd(), 'ingest', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  return db;
}

/**
 * Helper: Insert a session record (needed for FK constraints)
 */
function ensureSession(db: Database.Database, sessionId: string) {
  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!existing) {
    db.prepare(`
      INSERT INTO sessions (id, source, project, started_at, ended_at, status, message_count, user_message_count, has_tool_calls, parser_malformed_lines, is_truncated, file_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, 'openclaw', 'test', null, null, 'idle', 0, 0, 0, 0, 0, 'test.jsonl');
  }
}

/**
 * Helper: Insert a message into the test database
 */
function insertMessage(
  db: Database.Database,
  sessionId: string,
  ordinal: number,
  role: string,
  content: string,
  timestamp?: string,
  model?: string
) {
  ensureSession(db, sessionId);
  db.prepare(`
    INSERT INTO messages (id, session_id, ordinal, role, content, timestamp, model, token_usage_json, source_file, source_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${sessionId}-msg-${ordinal}`,
    sessionId,
    ordinal,
    role,
    content,
    timestamp || null,
    model || null,
    '',
    'test.jsonl',
    ordinal + 1
  );
}

/**
 * Helper: Insert a tool_call record
 */
function insertToolCall(
  db: Database.Database,
  sessionId: string,
  ordinal: number,
  toolId: string,
  name: string,
  status: string = 'pending',
  inputJson: string = '{}',
  category: string = 'Other'
) {
  return db.prepare(`
    INSERT INTO tool_calls (session_id, message_ordinal, tool_id, name, category, input_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, ordinal, toolId, name, category, inputJson, status).lastInsertRowid;
}

/**
 * Helper: Insert a tool_result_event record
 */
function insertToolResultEvent(
  db: Database.Database,
  toolCallId: number,
  content: string,
  isPartial: number = 0
) {
  db.prepare(`
    INSERT INTO tool_result_events (tool_call_id, content, is_partial)
    VALUES (?, ?, ?)
  `).run(toolCallId, content, isPartial);
}

// ============================================================================
// Tests
// ============================================================================

describe('turn assembler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('basic turn grouping (existing behavior)', () => {
    it('should group messages by user message boundaries', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-session-basic';

      insertMessage(db, sessionId, 0, 'user', 'Hello');
      insertMessage(db, sessionId, 1, 'assistant', 'Hi there');
      insertMessage(db, sessionId, 2, 'user', 'How are you?');
      insertMessage(db, sessionId, 3, 'assistant', 'I am fine');

      const turns = await assembleTurns(sessionId, db);

      expect(turns.length).toBe(2);
      expect(turns[0].userMessage?.content).toBe('Hello');
      expect(turns[0].assistantMessages.length).toBe(1);
      expect(turns[0].assistantMessages[0].content).toBe('Hi there');
      expect(turns[1].userMessage?.content).toBe('How are you?');
      expect(turns[1].assistantMessages[0].content).toBe('I am fine');
    });

    it('should handle empty sessions', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-session-empty';

      const turns = await assembleTurns(sessionId, db);

      expect(turns).toEqual([]);
    });

    it('should handle sessions with no user messages', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-no-user';

      insertMessage(db, sessionId, 0, 'assistant', 'Auto message');
      insertMessage(db, sessionId, 1, 'assistant', 'Another auto');

      const turns = await assembleTurns(sessionId, db);

      // No user messages => no turns (turn starts with user)
      expect(turns.length).toBe(0);
    });

    it('should calculate turn duration', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-duration';

      insertMessage(db, sessionId, 0, 'user', 'Hello', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'Hi', '2024-01-01T00:00:10Z');
      insertMessage(db, sessionId, 2, 'user', 'Next', '2024-01-01T00:01:00Z');
      insertMessage(db, sessionId, 3, 'assistant', 'Reply', '2024-01-01T00:01:05Z');

      const turns = await assembleTurns(sessionId, db);

      expect(turns.length).toBe(2);
      expect(turns[0].durationMs).toBe(60000); // 60 seconds (00:00:00 → 00:01:00, next user msg)
      expect(turns[1].durationMs).toBeNull();  // Last turn has no next user message to close it
    });
  });

  describe('compact boundary handling (D-10)', () => {
    it('should mark turn as truncated when compact boundary is detected', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-compact';

      insertMessage(db, sessionId, 0, 'user', 'Hello', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'Response', '2024-01-01T00:00:05Z');
      // Compact boundary — system message containing "[compact]"
      insertMessage(db, sessionId, 2, 'system', '[compact] Context was compacted', '2024-01-01T00:00:06Z');
      insertMessage(db, sessionId, 3, 'assistant', 'Continued after compact', '2024-01-01T00:00:10Z');
      insertMessage(db, sessionId, 4, 'user', 'Next message', '2024-01-01T00:01:00Z');
      insertMessage(db, sessionId, 5, 'assistant', 'Reply', '2024-01-01T00:01:05Z');

      const turns = await assembleTurns(sessionId, db);

      // First turn should be marked truncated (compact appeared within it)
      expect(turns.length).toBeGreaterThanOrEqual(1);
      const firstTurn = turns.find(t => t.index === 0);
      expect(firstTurn).toBeDefined();
      expect(firstTurn!.isTruncated).toBe(true);

      // Compact should have created a system event activity
      const compactActivity = firstTurn!.activities.find(
        (a) => a.type === 'system' && a.subtype === 'compact'
      );
      expect(compactActivity).toBeDefined();
    });

    it('should contain compact detection in assembler source', async () => {
      const fs = await import('fs');
      const assemblerSource = fs.readFileSync(
        join(process.cwd(), 'ingest', 'turns', 'assembler.ts'),
        'utf-8'
      );
      // acceptance_criteria: grep -c "compact" returns >= 2
      const compactCount = (assemblerSource.match(/compact/gi) || []).length;
      expect(compactCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('system message handling (D-02, D-10)', () => {
    it('should store system messages as system events, not in turn message lists', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-system';

      insertMessage(db, sessionId, 0, 'user', 'Hello', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'Hi', '2024-01-01T00:00:05Z');
      insertMessage(db, sessionId, 2, 'system', 'System notification: model switched', '2024-01-01T00:00:06Z');
      insertMessage(db, sessionId, 3, 'assistant', 'Continued', '2024-01-01T00:00:10Z');

      const turns = await assembleTurns(sessionId, db);

      expect(turns.length).toBeGreaterThanOrEqual(1);
      const turn = turns[0];

      // System message should NOT be in assistantMessages
      const systemInMessages = turn.assistantMessages.some(m => m.role === 'system');
      expect(systemInMessages).toBe(false);

      // System message should appear as a system event activity
      const systemActivity = turn.activities.find(
        (a) => a.type === 'system' && a.subtype === 'system_message'
      );
      expect(systemActivity).toBeDefined();
    });

    it('should expose Qoder injected context as a dedicated system event subtype', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-qoder-context';

      insertMessage(db, sessionId, 0, 'user', '分析一下这个项目', '2024-01-01T00:00:00Z');
      insertMessage(
        db,
        sessionId,
        1,
        'system',
        '[[qoder-injected-context]]\n<system-reminder>respond in 中文</system-reminder>',
        '2024-01-01T00:00:01Z'
      );
      insertMessage(db, sessionId, 2, 'assistant', '分析结果', '2024-01-01T00:00:02Z');

      const turns = await assembleTurns(sessionId, db);
      const qoderContext = turns[0].activities.find(
        (activity) => activity.type === 'system' && activity.subtype === 'qoder_injected_context'
      );

      expect(qoderContext).toBeDefined();
      expect(qoderContext?.type).toBe('system');
      if (qoderContext?.type !== 'system') throw new Error('Expected system activity');
      expect(qoderContext.content).toBe('<system-reminder>respond in 中文</system-reminder>');
    });
  });

  describe('queued command merging (D-05)', () => {
    it('should merge consecutive user messages with [QUEUED] prefix', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-queued';

      insertMessage(db, sessionId, 0, 'user', 'First command', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'user', '[QUEUED] Second command', '2024-01-01T00:00:01Z');
      insertMessage(db, sessionId, 2, 'user', '[QUEUED] Third command', '2024-01-01T00:00:02Z');
      insertMessage(db, sessionId, 3, 'assistant', 'Processing all commands', '2024-01-01T00:00:10Z');

      const turns = await assembleTurns(sessionId, db);

      // Merged into a single turn
      expect(turns.length).toBe(1);
      const turn = turns[0];

      // User message should contain all queued commands merged
      expect(turn.userMessage).toBeDefined();
      expect(turn.userMessage!.content).toContain('First command');
      expect(turn.userMessage!.content).toContain('Second command');
      expect(turn.userMessage!.content).toContain('Third command');

      // Should NOT contain literal [QUEUED] prefix
      expect(turn.userMessage!.content).not.toContain('[QUEUED]');
    });

    it('should merge consecutive user messages without intervening assistant messages', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-queued-no-prefix';

      insertMessage(db, sessionId, 0, 'user', 'First command', '2024-01-01T00:00:00Z');
      // Consecutive user message without QUEUED prefix but no assistant in between
      insertMessage(db, sessionId, 1, 'user', 'Additional context', '2024-01-01T00:00:01Z');
      insertMessage(db, sessionId, 2, 'assistant', 'Response', '2024-01-01T00:00:10Z');

      const turns = await assembleTurns(sessionId, db);

      expect(turns.length).toBe(1);
      expect(turns[0].userMessage!.content).toContain('First command');
      expect(turns[0].userMessage!.content).toContain('Additional context');
    });
  });

  describe('tool call pairing (D-11)', () => {
    it('should pair tool calls with result events by tool_call_id', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-tool-pairing';

      insertMessage(db, sessionId, 0, 'user', 'Read file.txt', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'Let me read that file', '2024-01-01T00:00:05Z');

      // Insert tool_call and result_event
      const toolCallId = insertToolCall(db, sessionId, 1, 'tool_use_123', 'Read', 'success', '{"filePath":"file.txt"}', 'Read');
      insertToolResultEvent(db, toolCallId as number, 'File contents here...', 0);

      insertMessage(db, sessionId, 2, 'user', 'Next turn', '2024-01-01T00:01:00Z');
      insertMessage(db, sessionId, 3, 'assistant', 'Ok', '2024-01-01T00:01:05Z');

      const turns = await assembleTurns(sessionId, db);

      expect(turns.length).toBeGreaterThanOrEqual(1);
      const firstTurn = turns[0];

      // Should have a tool_call activity
      const toolCalls = firstTurn.activities.filter((a) => a.type === 'tool_call');
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const tc = toolCalls[0];
      expect(tc.name).toBe('Read');
      expect(tc.status).toBe('success');
      expect(tc.messageOrdinal).toBe(1);
      expect(tc.resultEvents.length).toBeGreaterThanOrEqual(1);
      expect(tc.resultEvents[0].content).toBe('File contents here...');
    });

    it('should handle tool calls with pending/error status', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-tool-status';

      insertMessage(db, sessionId, 0, 'user', 'Test', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'Trying', '2024-01-01T00:00:05Z');

      insertToolCall(db, sessionId, 1, 'tool_use_err', 'Bash', 'error', '{"command":"bad"}', 'Bash');

      const turns = await assembleTurns(sessionId, db);

      const toolCalls = turns[0].activities.filter((a) => a.type === 'tool_call');
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const tc = toolCalls[0];
      expect(tc.status).toBe('error');
    });

    it('should handle sessions without tool calls gracefully', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-no-tools';

      insertMessage(db, sessionId, 0, 'user', 'Hello', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'Hi', '2024-01-01T00:00:05Z');

      const turns = await assembleTurns(sessionId, db);

      expect(turns.length).toBe(1);
      // No tool call activities
      const toolCalls = turns[0].activities.filter((a) => a.type === 'tool_call');
      expect(toolCalls.length).toBe(0);
    });
  });

  describe('subagent linking (D-11)', () => {
    it('should link subagent sessions within turns', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-parent-session';

      insertMessage(db, sessionId, 0, 'user', 'Spawn subagent', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'Spawning...', '2024-01-01T00:00:05Z');
      insertMessage(db, sessionId, 2, 'user', 'Next', '2024-01-01T00:01:00Z');
      insertMessage(db, sessionId, 3, 'assistant', 'Ok', '2024-01-01T00:01:05Z');

      // Insert a child session (subagent)
      db.prepare(`
        INSERT INTO sessions (id, source, project, started_at, ended_at, status, message_count, user_message_count, has_tool_calls, parser_malformed_lines, is_truncated, file_path, parent_session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'child-session-1', 'codex', 'test',
        '2024-01-01T00:00:02Z', '2024-01-01T00:00:04Z', 'idle',
        2, 1, 0, 0, 0, 'child.jsonl',
        sessionId
      );

      const turns = await assembleTurns(sessionId, db);

      // First turn should have a subagent link activity
      const firstTurn = turns[0];
      const subagentLinks = firstTurn.activities.filter((a) => a.type === 'subagent_link');
      expect(subagentLinks.length).toBeGreaterThanOrEqual(1);

      const link = subagentLinks[0];
      expect(link.subagentSessionId).toBe('child-session-1');
      expect(link.relationship).toBe('spawned');
    });

    it('should anchor subagent links to the turn and messageOrdinal of the matching Agent tool call', async () => {
      const { assembleTurns } = await import('@/ingest/turns/assembler');
      const sessionId = 'test-parent-agent-anchor';

      insertMessage(db, sessionId, 0, 'user', 'First turn', '2024-01-01T00:00:00Z');
      insertMessage(db, sessionId, 1, 'assistant', 'No subagent yet', '2024-01-01T00:00:05Z');
      insertMessage(db, sessionId, 2, 'user', 'Spawn subagent', '2024-01-01T00:01:00Z');
      insertMessage(db, sessionId, 3, 'assistant', 'Launching subagent', '2024-01-01T00:01:05Z');

      const toolCallId = insertToolCall(
        db,
        sessionId,
        3,
        'toolu_agent_anchor',
        'Agent',
        'success',
        '{"prompt":"do work"}',
        'Agent'
      );
      insertToolResultEvent(
        db,
        toolCallId as number,
        'Async agent launched successfully.\nagentId: agent-123',
        0
      );

      db.prepare(`
        INSERT INTO sessions (
          id, source, project, started_at, ended_at, status,
          message_count, user_message_count, has_tool_calls,
          parser_malformed_lines, is_truncated, file_path,
          parent_session_id, source_session_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'claude-agent:test-parent-agent-anchor:agent-123',
        'claude-code',
        'test',
        '2024-01-01T00:01:10Z',
        '2024-01-01T00:02:00Z',
        'idle',
        2,
        1,
        0,
        0,
        0,
        'child.jsonl',
        sessionId,
        'agent-123'
      );

      const turns = await assembleTurns(sessionId, db);

      expect(turns).toHaveLength(2);
      expect(turns[0].activities.some((activity) => activity.type === 'subagent_link')).toBe(false);
      const subagentLinks = turns[1].activities.filter((activity) => activity.type === 'subagent_link');
      expect(subagentLinks).toHaveLength(1);
      expect(subagentLinks[0].subagentSessionId).toBe('claude-agent:test-parent-agent-anchor:agent-123');
      expect(subagentLinks[0].messageOrdinal).toBe(3);
    });
  });
});
