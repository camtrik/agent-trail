/**
 * Real-shape parser regression tests
 *
 * Uses redacted real-shape fixtures from tests/fixtures/real-shape/ to guard
 * against envelope-vs-real-data regressions. Each test is structural (not
 * snapshot-based) so tests survive minor content changes while catching
 * parser breakage on real log shapes.
 *
 * Coverage targets (2026-05-08 investigation):
 *   - Claude tool_use + tool_result with matching tool_use_id
 *   - Claude thinking block interleaved with text
 *   - Claude isCompactSummary / compact boundary with truncatedUuids
 *   - Codex function_call_output with output field (not content)
 *   - Codex custom_tool_call + custom_tool_call_output
 *   - Codex reasoning and web_search_call (should NOT produce unknown-type warnings)
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseClaudeSession } from '@/ingest/parser/claude';
import { parseCodexSession } from '@/ingest/parser/codex';

const FIXTURE_DIR = path.join(process.cwd(), 'tests/fixtures/real-shape');

// ============================================================================
// Claude real-shape fixtures
// ============================================================================

describe('Claude parser — real-shape tool_use + tool_result', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'claude/tool-result.jsonl');

  it('does not throw when parsing tool_use + tool_result fixture', async () => {
    await expect(parseClaudeSession(fixturePath, 'test')).resolves.toBeDefined();
  });

  it('extracts at least one tool_call activity for tool_use block', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    const toolCalls = result.activities.filter(a => a.type === 'tool_call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('tool_use_id is preserved in tool_call id', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    const toolCalls = result.activities.filter(a => a.type === 'tool_call');
    // The fixture uses tool_use_id "toolu_rs01"
    expect(toolCalls.some(tc => tc.id === 'toolu_rs01')).toBe(true);
  });

  it('tool_result user message is parsed (role may be user or tool_result)', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    // tool_result lines come in as user-role messages in the raw JSONL
    const hasToolResultMsg = result.messages.some(
      m => m.role === 'user' || m.role === 'tool_result'
    );
    expect(hasToolResultMsg).toBe(true);
  });
});

describe('Claude parser — real-shape thinking block', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'claude/thinking.jsonl');

  it('does not throw when parsing thinking block fixture', async () => {
    await expect(parseClaudeSession(fixturePath, 'test')).resolves.toBeDefined();
  });

  it('produces at least one assistant message from thinking+text block', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    const assistantMsgs = result.messages.filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('does not produce unknown-type warnings for thinking blocks', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    const unknownWarnings = result.warnings.filter(w =>
      w.toLowerCase().includes('unknown') && w.toLowerCase().includes('thinking')
    );
    expect(unknownWarnings.length).toBe(0);
  });
});

describe('Claude parser — real-shape compact boundary (isCompactSummary)', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'claude/compact.jsonl');

  it('does not throw when parsing compact boundary fixture', async () => {
    await expect(parseClaudeSession(fixturePath, 'test')).resolves.toBeDefined();
  });

  it('produces a system message for the compact event', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    const systemMsgs = result.messages.filter(m => m.role === 'system');
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it('sets isTruncated on session metrics when compact boundary exists', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    expect(result.session.metrics.isTruncated).toBe(true);
  });

  it('preserves messages before and after the compact boundary', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    // Fixture has: assistant, compact, user — 3 messages total
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });

  it('compact system message content references truncatedUuids', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    const systemMsgs = result.messages.filter(m => m.role === 'system');
    // The fixture compact boundary includes truncatedUuids: ["rs-msg-before-01"]
    expect(systemMsgs[0].content).toContain('rs-msg-before-01');
  });
});

// ============================================================================
// Codex real-shape fixtures
// ============================================================================

describe('Codex parser — real-shape function_call_output', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'codex/function-call-output.jsonl');

  it('does not throw when parsing function_call_output fixture', async () => {
    await expect(parseCodexSession(fixturePath, 'test')).resolves.toBeDefined();
  });

  it('extracts at least one tool_call activity for function_call', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const toolCalls = result.activities.filter(a => a.type === 'tool_call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('function_call and function_call_output pair by call_id', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const toolCalls = result.activities.filter(
      a => a.type === 'tool_call'
    ) as import('@/types/trace').TraceToolCall[];
    // Tool call "call_rs01" should have at least one result event
    const paired = toolCalls.find(tc => tc.id === 'call_rs01');
    expect(paired).toBeDefined();
    expect(paired!.resultEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('function_call_output result event has non-empty content', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const toolCalls = result.activities.filter(
      a => a.type === 'tool_call'
    ) as import('@/types/trace').TraceToolCall[];
    const paired = toolCalls.find(tc => tc.id === 'call_rs01');
    expect(paired).toBeDefined();
    // Content should be the output field value from the event_msg
    expect(paired!.resultEvents[0].content.length).toBeGreaterThan(0);
  });

  it('function_call_output does not produce unknown-type warnings', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const unknownWarnings = result.warnings.filter(w =>
      w.includes('function_call_output') && w.toLowerCase().includes('unknown')
    );
    expect(unknownWarnings.length).toBe(0);
  });
});

describe('Codex parser — real-shape custom_tool_call + custom_tool_call_output', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'codex/custom-tool.jsonl');

  it('does not throw when parsing custom_tool_call fixture', async () => {
    await expect(parseCodexSession(fixturePath, 'test')).resolves.toBeDefined();
  });

  it('extracts at least one tool_call for custom_tool_call', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const toolCalls = result.activities.filter(a => a.type === 'tool_call');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('custom_tool_call and custom_tool_call_output pair by call_id', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const toolCalls = result.activities.filter(
      a => a.type === 'tool_call'
    ) as import('@/types/trace').TraceToolCall[];
    const paired = toolCalls.find(tc => tc.id === 'call_rs02');
    expect(paired).toBeDefined();
    expect(paired!.resultEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('custom_tool_call does not produce unknown-type warnings', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const unknownWarnings = result.warnings.filter(w =>
      w.includes('custom_tool_call') && w.toLowerCase().includes('unknown')
    );
    expect(unknownWarnings.length).toBe(0);
  });
});

describe('Codex parser — real-shape reasoning and web_search_call', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'codex/reasoning-web-search.jsonl');

  it('does not throw when parsing reasoning + web_search_call fixture', async () => {
    await expect(parseCodexSession(fixturePath, 'test')).resolves.toBeDefined();
  });

  it('reasoning record does not produce unknown-type warning spam', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const reasoningWarnings = result.warnings.filter(w =>
      w.includes('reasoning') && w.toLowerCase().includes('unknown')
    );
    expect(reasoningWarnings.length).toBe(0);
  });

  it('web_search_call record does not produce unknown-type warning spam', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const webSearchWarnings = result.warnings.filter(w =>
      w.includes('web_search_call') && w.toLowerCase().includes('unknown')
    );
    expect(webSearchWarnings.length).toBe(0);
  });

  it('text message after reasoning is parsed', async () => {
    const result = await parseCodexSession(fixturePath, 'test');
    const assistantMsgs = result.messages.filter(m => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Claude parser — api-request-blob lines are ignored', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'claude/request-blob.jsonl');

  it('produces one tool_call per tool_use id even when a blob repeats it', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    const toolCallIds = result.activities
      .filter(a => a.type === 'tool_call')
      .map(a => (a as { id: string }).id);
    expect(toolCallIds).toEqual(['toolu_rs02']);
  });

  it('does not create messages from blob records (no system or extra user turns)', async () => {
    const result = await parseClaudeSession(fixturePath, 'test');
    expect(result.messages.some(m => m.role === 'system')).toBe(false);
    expect(result.messages.filter(m => m.isRealUserInput).length).toBe(1);
    expect(result.messages.length).toBe(3);
  });
});
