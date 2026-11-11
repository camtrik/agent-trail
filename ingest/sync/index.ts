/**
 * Ingest Sync Layer
 *
 * Orchestrates sync operations between parsers and the database.
 * Handles session upserts, message insertion, and source-level sync.
 * Supports OpenClaw, Claude Code, and Codex sources.
 *
 * @module ingest/sync
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDatabase } from '../db';
import { IncrementalParseDelta, ParseResult, TokenUsageAttribution } from '../parser/types';
import { sseManager } from '../src/sse';
import { logger } from '../logger';
import type { TokenUsage } from '@/types/trace';

export const PARSER_CACHE_VERSION = 'parser-v14-skip-api-request-blobs';

const claudeProjectPathCache = new Map<string, string | null>();

// ============================================================================
// Types
// ============================================================================

export interface SyncResult {
  sessionsInserted: number;
  sessionsUpdated: number;
  messagesInserted: number;
  toolCallsInserted: number;
  toolResultEventsInserted: number;
  errors: string[];
  metrics?: SyncMetrics;
}

export interface SyncMetrics {
  filesConsidered: number;
  filesSkippedBeforeParse: number;
  filesParsed: number;
  filesParsedFully?: number;
  filesParsedIncrementally?: number;
  incrementalFallbacks?: number;
  largestFileBytes: number;
}

export interface SyncProgressEvent {
  sourceType: SyncSourceType;
  filePath: string;
  fileSize: number;
  currentOffset: number;
  filesConsidered: number;
  filesSkippedBeforeParse: number;
  filesParsed: number;
  largestFileBytes: number;
}

export interface SyncObserver {
  onFileStart?: (event: SyncProgressEvent) => void;
  onFileProgress?: (event: SyncProgressEvent) => void;
  onFileComplete?: (event: SyncProgressEvent) => void;
}

export type SyncSourceType = 'openclaw' | 'claude-code' | 'codex' | 'opencode' | 'qoder';

export interface FileSnapshotWithIdentity {
  size: number;
  mtimeIso: string;
  inode: number;
  device: number;
}

type FileSnapshot = FileSnapshotWithIdentity;

export interface IngestFileCursor {
  sourceType: SyncSourceType;
  filePath: string;
  sessionId: string | null;
  fileSize: number;
  fileMtime: string | null;
  fileInode: number | null;
  fileDevice: number | null;
  parserVersion: string;
  lastIndexedOffset: number;
  lastIndexedLine: number;
  lastMessageOrdinal: number;
  lastTurnIndex: number;
  lastSuccessAt: string | null;
  lastFallbackReason: string | null;
}

export type CursorFallbackReason =
  | 'no_cursor'
  | 'force'
  | 'snapshot_unavailable'
  | 'truncated'
  | 'file_identity_changed'
  | 'parser_version_changed'
  | 'invalid_offset'
  | 'rewrite_detected'
  | 'missing_cursor_session'
  | 'missing_cursor_session_row'
  | 'derived_rows_missing';

export type CursorDecision =
  | {
      type: 'skip_unchanged';
      cursor?: IngestFileCursor;
      snapshot: FileSnapshotWithIdentity;
      pendingPartialLine?: boolean;
    }
  | {
      type: 'incremental_append';
      cursor: IngestFileCursor;
      snapshot: FileSnapshotWithIdentity;
      startOffset: number;
      endOffset: number;
      startLine: number;
      startOrdinal: number;
      startTurnIndex: number;
    }
  | {
      type: 'full_reparse';
      reason: CursorFallbackReason;
      cursor?: IngestFileCursor;
      snapshot?: FileSnapshotWithIdentity;
    };

interface UpsertCursorInput {
  sourceType: SyncSourceType;
  filePath: string;
  sessionId: string;
  snapshot: FileSnapshotWithIdentity;
  lastIndexedOffset: number;
  lastIndexedLine: number;
  lastMessageOrdinal: number;
  lastTurnIndex: number;
  fallbackReason: string | null;
}

/**
 * Options for writeSessionToDatabase
 */
export interface WriteSessionOptions {
  /**
   * Force reparse — bypass the file_hash skip cache and always re-write derived rows.
   * Used when a parser fix has been applied and existing indexed sessions must be rebuilt.
   */
  force?: boolean;
  /**
   * Precomputed parser cache key to persist in sessions.file_hash.
   * SQLite-backed sources use per-session fingerprints rather than file bytes.
   */
  cacheFileHash?: string;
  /**
   * Real filesystem path used only for file_size/file_mtime when sourceFile is
   * a logical path such as "/path/local.db#session_id".
   */
  sourceFileStatsPath?: string;
}

function getSessionTokenTotals(parseResult: ParseResult): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
} {
  const metrics = parseResult.session.metrics;

  if (
    typeof metrics.inputTokens === 'number' ||
    typeof metrics.outputTokens === 'number' ||
    typeof metrics.cacheReadTokens === 'number' ||
    typeof metrics.cacheWriteTokens === 'number' ||
    typeof metrics.reasoningTokens === 'number' ||
    typeof metrics.totalTokens === 'number'
  ) {
    const inputTokens = metrics.inputTokens ?? 0;
    const outputTokens = metrics.outputTokens ?? 0;
    const cacheReadTokens = metrics.cacheReadTokens ?? 0;
    const cacheWriteTokens = metrics.cacheWriteTokens ?? 0;
    const reasoningTokens = metrics.reasoningTokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens: metrics.totalTokens
        ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  for (const message of parseResult.messages) {
    const usage = message.tokenUsage;
    if (!usage) continue;

    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    reasoningTokens += usage.reasoningTokens ?? 0;
    totalTokens += usage.totalTokens
      ?? usage.inputTokens
        + usage.outputTokens
        + (usage.cacheReadTokens ?? 0)
        + (usage.cacheWriteTokens ?? 0)
        + (usage.reasoningTokens ?? 0);
  }

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0 &&
    reasoningTokens === 0 &&
    totalTokens === 0
  ) {
    return {
      inputTokens: 0,
      outputTokens: metrics.totalTokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: metrics.totalTokens ?? 0,
    };
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}

interface DailyTokenRollupRow {
  sessionId: string;
  source: SyncSourceType;
  project: string;
  usageDate: string;
  attribution: TokenUsageAttribution;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

type TokenTotals = Omit<DailyTokenRollupRow, 'sessionId' | 'source' | 'project' | 'usageDate' | 'attribution'>;

function getTokenUsageTotal(usage: TokenUsage): number {
  return usage.totalTokens
    ?? usage.inputTokens
      + usage.outputTokens
      + (usage.cacheReadTokens ?? 0)
      + (usage.cacheWriteTokens ?? 0)
      + (usage.reasoningTokens ?? 0);
}

function normalizeTokenUsage(usage: TokenUsage): TokenTotals {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens: getTokenUsageTotal(usage),
  };
}

function hasTokenTotals(totals: TokenTotals): boolean {
  return totals.inputTokens > 0
    || totals.outputTokens > 0
    || totals.cacheReadTokens > 0
    || totals.cacheWriteTokens > 0
    || totals.reasoningTokens > 0
    || totals.totalTokens > 0;
}

function sumDailyTokenRows(rows: DailyTokenRollupRow[]): TokenTotals {
  return rows.reduce<TokenTotals>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
      reasoningTokens: sum.reasoningTokens + row.reasoningTokens,
      totalTokens: sum.totalTokens + row.totalTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    }
  );
}

function subtractTokenTotals(current: TokenTotals, previous: TokenTotals): TokenTotals {
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateKeyFromTimestamp(timestamp?: string | null): string | null {
  if (!timestamp) return null;
  const trimmed = timestamp.trim();
  if (!trimmed) return null;

  // Date-only strings carry no time/zone — use verbatim. Passing them through
  // new Date() would parse them as UTC midnight and shift the day backwards in
  // negative-offset timezones.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) return null;
  return localDateKey(parsed);
}

function getSessionTokenFallbackTimestamp(
  session: ParseResult['session'],
  fallbackTimestamp?: string | null
): string | null {
  return session.updatedAt
    || session.endedAt
    || session.startedAt
    || fallbackTimestamp
    || null;
}

function getSessionTokenResidualTimestamp(
  session: ParseResult['session'],
  fallbackTimestamp?: string | null
): string | null {
  return session.startedAt
    || fallbackTimestamp
    || session.updatedAt
    || session.endedAt
    || null;
}

function addDailyTokenRollup(
  map: Map<string, DailyTokenRollupRow>,
  input: {
    sessionId: string;
    source: SyncSourceType;
    project: string;
    timestamp?: string | null;
    fallbackTimestamp?: string | null;
    attribution: TokenUsageAttribution;
    totals: TokenTotals;
  }
): void {
  if (!hasTokenTotals(input.totals)) return;

  const usageDate = dateKeyFromTimestamp(input.timestamp) ?? dateKeyFromTimestamp(input.fallbackTimestamp);
  if (!usageDate) return;

  const project = input.project || 'default';
  const key = `${input.sessionId}:${usageDate}`;
  const existing = map.get(key);
  if (existing) {
    existing.inputTokens += input.totals.inputTokens;
    existing.outputTokens += input.totals.outputTokens;
    existing.cacheReadTokens += input.totals.cacheReadTokens;
    existing.cacheWriteTokens += input.totals.cacheWriteTokens;
    existing.reasoningTokens += input.totals.reasoningTokens;
    existing.totalTokens += input.totals.totalTokens;
    existing.attribution = input.attribution;
    return;
  }

  map.set(key, {
    sessionId: input.sessionId,
    source: input.source,
    project,
    usageDate,
    attribution: input.attribution,
    inputTokens: input.totals.inputTokens,
    outputTokens: input.totals.outputTokens,
    cacheReadTokens: input.totals.cacheReadTokens,
    cacheWriteTokens: input.totals.cacheWriteTokens,
    reasoningTokens: input.totals.reasoningTokens,
    totalTokens: input.totals.totalTokens,
  });
}

function buildDailyTokenRowsForParseResult(
  parseResult: ParseResult,
  fallbackTimestamp?: string | null,
  sessionTotals = getSessionTokenTotals(parseResult)
): DailyTokenRollupRow[] {
  const map = new Map<string, DailyTokenRollupRow>();
  const source = parseResult.session.source as SyncSourceType;
  const sessionFallbackTimestamp = getSessionTokenFallbackTimestamp(parseResult.session, fallbackTimestamp);

  if (parseResult.tokenEvents && parseResult.tokenEvents.length > 0) {
    for (const event of parseResult.tokenEvents) {
      addDailyTokenRollup(map, {
        sessionId: parseResult.session.id,
        source,
        project: parseResult.session.project,
        timestamp: event.timestamp,
        fallbackTimestamp: sessionFallbackTimestamp,
        attribution: event.attribution,
        totals: normalizeTokenUsage(event.usage),
      });
    }

    const residualTotals = subtractTokenTotals(sessionTotals, sumDailyTokenRows([...map.values()]));
    addDailyTokenRollup(map, {
      sessionId: parseResult.session.id,
      source,
      project: parseResult.session.project,
      timestamp: getSessionTokenResidualTimestamp(parseResult.session, fallbackTimestamp),
      fallbackTimestamp: sessionFallbackTimestamp,
      attribution: 'session',
      totals: residualTotals,
    });

    return [...map.values()];
  }

  for (const message of parseResult.messages) {
    if (!message.tokenUsage) continue;
    addDailyTokenRollup(map, {
      sessionId: parseResult.session.id,
      source,
      project: parseResult.session.project,
      timestamp: message.timestamp,
      fallbackTimestamp: sessionFallbackTimestamp,
      attribution: 'message',
      totals: normalizeTokenUsage(message.tokenUsage),
    });
  }

  if (map.size > 0) return [...map.values()];

  addDailyTokenRollup(map, {
    sessionId: parseResult.session.id,
    source,
    project: parseResult.session.project,
    timestamp: sessionFallbackTimestamp,
    attribution: 'session',
    totals: sessionTotals,
  });

  return [...map.values()];
}

function buildDailyTokenRowsForDelta(
  delta: IncrementalParseDelta,
  project: string,
  fallbackTimestamp?: string | null
): DailyTokenRollupRow[] {
  const map = new Map<string, DailyTokenRollupRow>();

  if (delta.tokenEvents && delta.tokenEvents.length > 0) {
    for (const event of delta.tokenEvents) {
      addDailyTokenRollup(map, {
        sessionId: delta.sessionId,
        source: delta.sourceType,
        project,
        timestamp: event.timestamp,
        fallbackTimestamp,
        attribution: event.attribution,
        totals: normalizeTokenUsage(event.usage),
      });
    }
    return [...map.values()];
  }

  for (const message of delta.messages) {
    if (!message.tokenUsage) continue;
    addDailyTokenRollup(map, {
      sessionId: delta.sessionId,
      source: delta.sourceType,
      project,
      timestamp: message.timestamp,
      fallbackTimestamp,
      attribution: 'message',
      totals: normalizeTokenUsage(message.tokenUsage),
    });
  }

  if (map.size > 0) return [...map.values()];

  const totals: TokenTotals = {
    inputTokens: delta.metricsDelta.totalInputTokens,
    outputTokens: delta.metricsDelta.totalOutputTokens,
    cacheReadTokens: delta.metricsDelta.totalCacheReadTokens ?? 0,
    cacheWriteTokens: delta.metricsDelta.totalCacheWriteTokens ?? 0,
    reasoningTokens: delta.metricsDelta.totalReasoningTokens ?? 0,
    totalTokens: delta.metricsDelta.totalTokens
      ?? delta.metricsDelta.totalInputTokens
        + delta.metricsDelta.totalOutputTokens
        + (delta.metricsDelta.totalCacheReadTokens ?? 0)
        + (delta.metricsDelta.totalCacheWriteTokens ?? 0)
        + (delta.metricsDelta.totalReasoningTokens ?? 0),
  };
  addDailyTokenRollup(map, {
    sessionId: delta.sessionId,
    source: delta.sourceType,
    project,
    timestamp: delta.sessionPatch.updatedAt
      || delta.sessionPatch.endedAt
      || delta.sessionPatch.startedAt
      || fallbackTimestamp,
    attribution: 'session',
    totals,
  });

  return [...map.values()];
}

function insertDailyTokenRows(database: Database.Database, rows: DailyTokenRollupRow[]): void {
  if (rows.length === 0) return;

  const insert = database.prepare(`
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, usage_date) DO UPDATE SET
      source = excluded.source,
      project = excluded.project,
      attribution = excluded.attribution,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      total_tokens = excluded.total_tokens
  `);

  for (const row of rows) {
    insert.run(
      row.sessionId,
      row.source,
      row.project,
      row.usageDate,
      row.attribution,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.reasoningTokens,
      row.totalTokens
    );
  }
}

function addDailyTokenRows(database: Database.Database, rows: DailyTokenRollupRow[]): void {
  if (rows.length === 0) return;

  const upsert = database.prepare(`
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, usage_date) DO UPDATE SET
      source = excluded.source,
      project = excluded.project,
      attribution = excluded.attribution,
      input_tokens = session_token_daily.input_tokens + excluded.input_tokens,
      output_tokens = session_token_daily.output_tokens + excluded.output_tokens,
      cache_read_tokens = session_token_daily.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = session_token_daily.cache_write_tokens + excluded.cache_write_tokens,
      reasoning_tokens = session_token_daily.reasoning_tokens + excluded.reasoning_tokens,
      total_tokens = session_token_daily.total_tokens + excluded.total_tokens
  `);

  for (const row of rows) {
    upsert.run(
      row.sessionId,
      row.source,
      row.project,
      row.usageDate,
      row.attribution,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.reasoningTokens,
      row.totalTokens
    );
  }
}

// ============================================================================
// Session Name & Project Extraction
// ============================================================================

const SESSION_NAME_SCAN_LIMIT = 16 * 1024;
const SESSION_NAME_METADATA_HEADER_LIMIT = 128;

/**
 * Extract a display name from the first user message in the parse result.
 */
function extractSessionName(parseResult: ParseResult): string {
  for (const message of parseResult.messages) {
    if (message.role !== 'user') continue

    const candidate = deriveDisplayNameFromUserMessage(message.content)
    if (candidate) return candidate
  }

  return ''
}

function deriveDisplayNameFromUserMessage(content: string): string {
  const preview = boundedTrimmedPreview(content)
  if (!preview) return ''

  const lower = preview.toLowerCase()

  const commandArgs = extractTagContent(preview, lower, 'command-args')
  if (commandArgs) return truncateDisplayName(commandArgs)

  // Slash command with no args (e.g. /effort, /model) — skip, let loop find real user message
  if (lower.includes('<command-name>')) return ''

  const codexRequestMarker = '## my request for codex:'
  const codexRequestIdx = lower.indexOf(codexRequestMarker)
  if (codexRequestIdx >= 0) {
    const codexRequest = preview.slice(codexRequestIdx + codexRequestMarker.length)
    const line = firstMeaningfulLine(codexRequest)
    if (line) return truncateDisplayName(line)
  }

  // OpenClaw channel messages inject metadata blocks before the actual user text.
  // Headers include "Conversation info (untrusted metadata):", "Sender (untrusted metadata):", etc.
  // The actual message follows all the ```json ... ``` code blocks, optionally with a
  // gateway-injected date prefix like "[Wed 2026-04-29 00:58 GMT+8] ".
  if (lower.slice(0, SESSION_NAME_METADATA_HEADER_LIMIT).includes('(untrusted metadata):')) {
    const lastIdx = findLastFenceLineEnd(preview)
    const afterBlocks = trimSlice(preview, lastIdx, preview.length)
    if (afterBlocks) {
      // Strip gateway-injected date prefix: "[Wed 2026-04-29 00:58 GMT+8] "
      const stripped = stripBracketDatePrefix(afterBlocks)
      const line = firstMeaningfulLine(stripped || afterBlocks)
      if (line) return truncateDisplayName(line)
    }
    return ''
  }

  const metadataPrefixes = [
    '<environment_context',
    '<security_context',
    '<local-command-caveat',
    '<local-command-stdout',
    '<command-message',
    'base directory for this skill:',
    '# context from my ide setup:',
  ]
  if (metadataPrefixes.some(prefix => lower.startsWith(prefix))) return ''

  const line = firstMeaningfulLine(preview)
  return line ? truncateDisplayName(line) : ''
}

function firstMeaningfulLine(content: string): string {
  const scanEnd = Math.min(content.length, SESSION_NAME_SCAN_LIMIT)
  let lineStart = 0

  for (let i = 0; i <= scanEnd; i++) {
    const isScanEnd = i === scanEnd
    const code = isScanEnd ? 10 : content.charCodeAt(i)
    if (!isScanEnd && code !== 10 && code !== 13) continue

    const line = trimSlice(content, lineStart, i)
    if (line) return line

    if (code === 13 && i + 1 < scanEnd && content.charCodeAt(i + 1) === 10) {
      i++
    }
    lineStart = i + 1
  }

  return ''
}

function boundedTrimmedPreview(content: string): string {
  const scanEnd = Math.min(content.length, SESSION_NAME_SCAN_LIMIT)
  let start = 0

  while (start < scanEnd && isWhitespaceCode(content.charCodeAt(start))) {
    start++
  }
  if (start >= scanEnd) return ''

  return trimSlice(content, start, scanEnd)
}

function extractTagContent(preview: string, lowerPreview: string, tag: string): string {
  const openTag = `<${tag}>`
  const closeTag = `</${tag}>`
  const openIdx = lowerPreview.indexOf(openTag)
  if (openIdx < 0) return ''

  const contentStart = openIdx + openTag.length
  const closeIdx = lowerPreview.indexOf(closeTag, contentStart)
  if (closeIdx < 0) return ''

  return trimSlice(preview, contentStart, closeIdx)
}

function findLastFenceLineEnd(content: string): number {
  let lastIdx = 0
  let searchFrom = 0

  while (searchFrom < content.length) {
    const fenceIdx = content.indexOf('```', searchFrom)
    if (fenceIdx < 0) break

    let lineEnd = fenceIdx + 3
    while (lineEnd < content.length) {
      const code = content.charCodeAt(lineEnd)
      if (code === 10) {
        lastIdx = lineEnd + 1
        break
      }
      if (!isHorizontalWhitespaceCode(code) && code !== 13) break
      lineEnd++
    }

    searchFrom = fenceIdx + 3
  }

  return lastIdx
}

function stripBracketDatePrefix(content: string): string {
  if (!content.startsWith('[')) return content

  const closeIdx = content.indexOf(']', 1)
  if (closeIdx < 2 || closeIdx > 61) return content

  return trimSlice(content, closeIdx + 1, content.length) || content
}

function trimSlice(content: string, start: number, end: number): string {
  while (start < end && isWhitespaceCode(content.charCodeAt(start))) {
    start++
  }
  while (end > start && isWhitespaceCode(content.charCodeAt(end - 1))) {
    end--
  }

  return content.slice(start, end)
}

function isWhitespaceCode(code: number): boolean {
  return isHorizontalWhitespaceCode(code) || code === 10 || code === 13
}

function isHorizontalWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 11 || code === 12 || code === 160
}

function truncateDisplayName(line: string): string {
  return line.length > 80 ? line.slice(0, 77) + '...' : line
}

/**
 * Extract project path from the session file path based on source type.
 *
 * - Claude Code: ~/.claude/projects/{encoded-path}/ → decode to actual cwd
 * - OpenClaw: extract agent name from agents/{name}/sessions structure
 * - Codex: use session metadata, not date directory names
 */
function extractProjectFromPath(filePath: string, sourceType: SyncSourceType): string {
  if (sourceType === 'claude-code') {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
    const relative = path.relative(projectsRoot, path.dirname(filePath))
    if (!relative || relative.startsWith('..')) return 'default'
    const encoded = relative.split(path.sep)[0]
    return decodeClaudeProjectPath(encoded) ?? 'default'
  }

  if (sourceType === 'openclaw') {
    // Path structure: {openclaw-dir}/agents/{agentName}/sessions/{file}.jsonl
    // Return the openclaw dir name (e.g. ".openclaw"), not the agent name.
    const parts = path.dirname(filePath).split(path.sep)
    const agentsIdx = parts.lastIndexOf('agents')
    if (agentsIdx > 0) return parts[agentsIdx - 1]
    return 'default'
  }

  // Codex stores sessions under date directories like YYYY/MM/DD; the real
  // project comes from session metadata (`cwd`) when available.
  return 'default'
}

function decodeClaudeProjectPath(encoded: string): string | null {
  const cached = claudeProjectPathCache.get(encoded);
  if (cached !== undefined) return cached;

  const resolved = resolveExistingHyphenEncodedAbsolutePath(encoded);
  claudeProjectPathCache.set(encoded, resolved);
  return resolved;
}

function resolveExistingHyphenEncodedAbsolutePath(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null;

  const parts = encoded.slice(1).split('-').filter(Boolean);
  if (parts.length === 0) return null;

  let current: string = path.sep;
  let index = 0;

  while (index < parts.length) {
    let matched: string | null = null;
    let matchedEnd = index;

    for (let end = parts.length; end > index; end--) {
      const candidate = parts.slice(index, end).join('-');
      const candidatePath = path.join(current, candidate);
      try {
        if (fs.statSync(candidatePath).isDirectory()) {
          matched = candidate;
          matchedEnd = end;
          break;
        }
      } catch {
        // Keep trying shorter segment groupings.
      }
    }

    if (!matched) return null;
    current = path.join(current, matched);
    index = matchedEnd;
  }

  return current;
}

function extractProjectFromParsedSession(
  parseResult: ParseResult,
  fallbackProject: string
): string {
  if (parseResult.session.cwd?.trim()) {
    return parseResult.session.cwd.trim()
  }

  if (parseResult.session.project && parseResult.session.project !== 'default') {
    return parseResult.session.project
  }

  const cwd = parseResult.messages
    .map(m => m.sourceMetadata.cwd?.trim())
    .find((value): value is string => Boolean(value))

  return cwd || fallbackProject || 'default'
}

/**
 * Extract agent name from OpenClaw file path.
 *
 * Path structure: {openclaw-dir}/agents/{agentName}/sessions/{file}.jsonl
 */
function extractAgentNameFromPath(filePath: string, sourceType: SyncSourceType): string | undefined {
  if (sourceType !== 'openclaw') return undefined
  const parts = path.dirname(filePath).split(path.sep)
  const agentsIdx = parts.lastIndexOf('agents')
  if (agentsIdx >= 0 && agentsIdx + 1 < parts.length) return parts[agentsIdx + 1]
  return undefined
}

// ============================================================================
// Database Write Operations
// ============================================================================

/**
 * Compute SHA-256 hash of a file for skip-cache deduplication.
 *
 * @param filePath - Path to the file on disk
 * @returns Hex-encoded SHA-256 digest
 */
export function computeFileHash(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

function buildParserCacheHash(source: string, fileHash: string): string {
  return `${PARSER_CACHE_VERSION}:${source}:${fileHash}`;
}

function hasCurrentParserCacheHash(sourceType: SyncSourceType, fileHash: string | null): boolean {
  return Boolean(fileHash?.startsWith(`${PARSER_CACHE_VERSION}:${sourceType}:`));
}

function createSyncResult(): SyncResult {
  return {
    sessionsInserted: 0,
    sessionsUpdated: 0,
    messagesInserted: 0,
    toolCallsInserted: 0,
    toolResultEventsInserted: 0,
    errors: [],
    metrics: {
      filesConsidered: 0,
      filesSkippedBeforeParse: 0,
      filesParsed: 0,
      filesParsedFully: 0,
      filesParsedIncrementally: 0,
      incrementalFallbacks: 0,
      largestFileBytes: 0,
    },
  };
}

function mergeSyncResult(target: SyncResult, result: SyncResult): void {
  target.sessionsInserted += result.sessionsInserted;
  target.sessionsUpdated += result.sessionsUpdated;
  target.messagesInserted += result.messagesInserted;
  target.toolCallsInserted += result.toolCallsInserted;
  target.toolResultEventsInserted += result.toolResultEventsInserted;
  target.errors.push(...result.errors);

  if (target.metrics && result.metrics) {
    target.metrics.filesConsidered += result.metrics.filesConsidered;
    target.metrics.filesSkippedBeforeParse += result.metrics.filesSkippedBeforeParse;
    target.metrics.filesParsed += result.metrics.filesParsed;
    target.metrics.filesParsedFully = (target.metrics.filesParsedFully ?? 0) + (result.metrics.filesParsedFully ?? 0);
    target.metrics.filesParsedIncrementally = (target.metrics.filesParsedIncrementally ?? 0) + (result.metrics.filesParsedIncrementally ?? 0);
    target.metrics.incrementalFallbacks = (target.metrics.incrementalFallbacks ?? 0) + (result.metrics.incrementalFallbacks ?? 0);
    target.metrics.largestFileBytes = Math.max(
      target.metrics.largestFileBytes,
      result.metrics.largestFileBytes
    );
  }
}

function tryGetFileSnapshot(filePath: string): FileSnapshot | undefined {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      mtimeIso: new Date(stats.mtimeMs).toISOString(),
      inode: stats.ino,
      device: stats.dev,
    };
  } catch {
    return undefined;
  }
}

export function readFileSnapshotWithIdentity(filePath: string): FileSnapshotWithIdentity | undefined {
  return tryGetFileSnapshot(filePath);
}

function rowToCursor(row: Record<string, unknown>): IngestFileCursor {
  return {
    sourceType: row.source_type as SyncSourceType,
    filePath: row.file_path as string,
    sessionId: (row.session_id as string | null) ?? null,
    fileSize: Number(row.file_size ?? 0),
    fileMtime: (row.file_mtime as string | null) ?? null,
    fileInode: row.file_inode == null ? null : Number(row.file_inode),
    fileDevice: row.file_device == null ? null : Number(row.file_device),
    parserVersion: String(row.parser_version ?? ''),
    lastIndexedOffset: Number(row.last_indexed_offset ?? 0),
    lastIndexedLine: Number(row.last_indexed_line ?? 0),
    lastMessageOrdinal: Number(row.last_message_ordinal ?? -1),
    lastTurnIndex: Number(row.last_turn_index ?? -1),
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    lastFallbackReason: (row.last_fallback_reason as string | null) ?? null,
  };
}

export function getIngestFileCursor(
  sourceType: SyncSourceType,
  filePath: string,
  database: Database.Database = getDatabase()
): IngestFileCursor | undefined {
  const row = database.prepare(`
    SELECT *
    FROM ingest_file_cursors
    WHERE source_type = ? AND file_path = ?
  `).get(sourceType, filePath) as Record<string, unknown> | undefined;

  return row ? rowToCursor(row) : undefined;
}

function getSessionDerivedRowsReparseReason(
  database: Database.Database,
  sessionId: string | null
): CursorFallbackReason | null {
  if (!sessionId) return 'missing_cursor_session';

  try {
    const session = database.prepare(`
      SELECT message_count
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as {
      message_count: number | null;
    } | undefined;

    if (!session) return 'missing_cursor_session_row';

    const expectedMessages = Number(session.message_count ?? 0);
    if (expectedMessages > 0) {
      const actual = database.prepare(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE session_id = ?
      `).get(sessionId) as { count: number };

      if (Number(actual.count ?? 0) < expectedMessages) {
        return 'derived_rows_missing';
      }
    }
  } catch {
    return null;
  }

  try {
    const session = database.prepare(`
      SELECT
        source,
        total_input_tokens,
        total_output_tokens,
        total_cache_read_tokens,
        total_cache_write_tokens,
        total_reasoning_tokens,
        total_tokens
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as {
      source: SyncSourceType;
      total_input_tokens: number | null;
      total_output_tokens: number | null;
      total_cache_read_tokens: number | null;
      total_cache_write_tokens: number | null;
      total_reasoning_tokens: number | null;
      total_tokens: number | null;
    } | undefined;

    if (!session) return null;

    const channelTotal =
      Number(session.total_input_tokens ?? 0)
      + Number(session.total_output_tokens ?? 0)
      + Number(session.total_cache_read_tokens ?? 0)
      + Number(session.total_cache_write_tokens ?? 0)
      + Number(session.total_reasoning_tokens ?? 0);
    const tokenTotal = session.source === 'opencode'
      ? channelTotal
      : Math.max(Number(session.total_tokens ?? 0), channelTotal);

    if (tokenTotal <= 0) return null;

    const daily = database.prepare(`
      SELECT COUNT(*) AS count
      FROM session_token_daily
      WHERE session_id = ?
    `).get(sessionId) as { count: number };

    return Number(daily.count ?? 0) === 0
      ? 'derived_rows_missing'
      : null;
  } catch {
    return null;
  }
}

export function findLastCompleteJsonlOffset(
  filePath: string,
  startOffset: number,
  endOffset?: number
): number {
  const fileSize = endOffset ?? fs.statSync(filePath).size;
  if (startOffset < 0 || startOffset > fileSize) {
    throw new Error(`Invalid JSONL offset range: ${startOffset}..${fileSize}`);
  }

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = startOffset;
  let lastCompleteOffset = startOffset;

  try {
    while (position < fileSize) {
      const toRead = Math.min(buffer.length, fileSize - position);
      const bytesRead = fs.readSync(fd, buffer, 0, toRead, position);
      if (bytesRead <= 0) break;

      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 10) {
          lastCompleteOffset = position + i + 1;
        }
      }

      position += bytesRead;
    }
  } finally {
    fs.closeSync(fd);
  }

  return lastCompleteOffset;
}

export function decideCursorSync(
  sourceType: SyncSourceType,
  filePath: string,
  snapshot: FileSnapshotWithIdentity | undefined,
  opts: SyncSourceOptions,
  database?: Database.Database
): CursorDecision {
  if (!snapshot) {
    return { type: 'full_reparse', reason: 'snapshot_unavailable' };
  }

  if (opts.force) {
    return { type: 'full_reparse', reason: 'force', snapshot };
  }

  const cursor = getIngestFileCursor(sourceType, filePath, database ?? getDatabase());
  if (!cursor) {
    return { type: 'full_reparse', reason: 'no_cursor', snapshot };
  }

  const derivedRowsReason = getSessionDerivedRowsReparseReason(
    database ?? getDatabase(),
    cursor.sessionId
  );
  if (derivedRowsReason) {
    return { type: 'full_reparse', reason: derivedRowsReason, cursor, snapshot };
  }

  if (cursor.parserVersion !== PARSER_CACHE_VERSION) {
    return { type: 'full_reparse', reason: 'parser_version_changed', cursor, snapshot };
  }

  if (
    cursor.lastIndexedOffset < 0 ||
    cursor.lastIndexedOffset > cursor.fileSize ||
    cursor.lastIndexedLine < 0 ||
    cursor.lastMessageOrdinal < -1 ||
    cursor.lastTurnIndex < -1
  ) {
    return { type: 'full_reparse', reason: 'invalid_offset', cursor, snapshot };
  }

  if (snapshot.size < cursor.lastIndexedOffset || snapshot.size < cursor.fileSize) {
    return { type: 'full_reparse', reason: 'truncated', cursor, snapshot };
  }

  if (cursor.fileInode == null || cursor.fileDevice == null) {
    return { type: 'full_reparse', reason: 'file_identity_changed', cursor, snapshot };
  }

  if (cursor.fileInode !== snapshot.inode || cursor.fileDevice !== snapshot.device) {
    return { type: 'full_reparse', reason: 'file_identity_changed', cursor, snapshot };
  }

  if (snapshot.size === cursor.fileSize && snapshot.mtimeIso === cursor.fileMtime) {
    return { type: 'skip_unchanged', cursor, snapshot };
  }

  if (snapshot.size <= cursor.lastIndexedOffset) {
    return { type: 'full_reparse', reason: 'rewrite_detected', cursor, snapshot };
  }

  const safeEndOffset = findLastCompleteJsonlOffset(
    filePath,
    cursor.lastIndexedOffset,
    snapshot.size
  );

  if (safeEndOffset <= cursor.lastIndexedOffset) {
    return { type: 'skip_unchanged', cursor, snapshot, pendingPartialLine: true };
  }

  return {
    type: 'incremental_append',
    cursor,
    snapshot,
    startOffset: cursor.lastIndexedOffset,
    endOffset: safeEndOffset,
    startLine: cursor.lastIndexedLine,
    startOrdinal: cursor.lastMessageOrdinal + 1,
    startTurnIndex: cursor.lastTurnIndex,
  };
}

function upsertIngestFileCursor(database: Database.Database, input: UpsertCursorInput): void {
  database.prepare(`
    INSERT INTO ingest_file_cursors (
      source_type,
      file_path,
      session_id,
      file_size,
      file_mtime,
      file_inode,
      file_device,
      parser_version,
      last_indexed_offset,
      last_indexed_line,
      last_message_ordinal,
      last_turn_index,
      last_success_at,
      last_fallback_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_type, file_path) DO UPDATE SET
      session_id = excluded.session_id,
      file_size = excluded.file_size,
      file_mtime = excluded.file_mtime,
      file_inode = excluded.file_inode,
      file_device = excluded.file_device,
      parser_version = excluded.parser_version,
      last_indexed_offset = excluded.last_indexed_offset,
      last_indexed_line = excluded.last_indexed_line,
      last_message_ordinal = excluded.last_message_ordinal,
      last_turn_index = excluded.last_turn_index,
      last_success_at = excluded.last_success_at,
      last_fallback_reason = excluded.last_fallback_reason
  `).run(
    input.sourceType,
    input.filePath,
    input.sessionId,
    input.snapshot.size,
    input.snapshot.mtimeIso,
    input.snapshot.inode,
    input.snapshot.device,
    PARSER_CACHE_VERSION,
    input.lastIndexedOffset,
    input.lastIndexedLine,
    input.lastMessageOrdinal,
    input.lastTurnIndex,
    new Date().toISOString(),
    input.fallbackReason
  );
}

function countCompleteJsonlLines(filePath: string): number {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let count = 0;

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 10) count++;
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  return count;
}

function updateCursorAfterFullParse(
  database: Database.Database,
  sourceType: SyncSourceType,
  filePath: string,
  parseResult: ParseResult,
  fallbackReason: string | null
): void {
  const snapshot = tryGetFileSnapshot(filePath);
  if (!snapshot) return;

  const lastMessageOrdinal = parseResult.messages.reduce(
    (max, message) => Math.max(max, message.ordinal),
    -1
  );
  const lastTurnIndex = parseResult.messages.reduce(
    (max, message) => Math.max(max, typeof message.turnIndex === 'number' ? message.turnIndex : -1),
    -1
  );

  upsertIngestFileCursor(database, {
    sourceType,
    filePath,
    sessionId: parseResult.session.id,
    snapshot,
    lastIndexedOffset: snapshot.size,
    lastIndexedLine: countCompleteJsonlLines(filePath),
    lastMessageOrdinal,
    lastTurnIndex,
    fallbackReason,
  });
}

function recordFileConsidered(result: SyncResult, snapshot?: FileSnapshot): void {
  if (!result.metrics) return;
  result.metrics.filesConsidered += 1;
  if (snapshot) {
    result.metrics.largestFileBytes = Math.max(result.metrics.largestFileBytes, snapshot.size);
  }
}

function recordFileSkippedBeforeParse(result: SyncResult): void {
  if (!result.metrics) return;
  result.metrics.filesSkippedBeforeParse += 1;
}

function recordFileParsed(result: SyncResult, mode: 'full' | 'incremental' = 'full'): void {
  if (!result.metrics) return;
  result.metrics.filesParsed += 1;
  if (mode === 'incremental') {
    result.metrics.filesParsedIncrementally = (result.metrics.filesParsedIncrementally ?? 0) + 1;
  } else {
    result.metrics.filesParsedFully = (result.metrics.filesParsedFully ?? 0) + 1;
  }
}

function recordIncrementalFallback(result: SyncResult): void {
  if (!result.metrics) return;
  result.metrics.incrementalFallbacks = (result.metrics.incrementalFallbacks ?? 0) + 1;
}

function buildProgressEvent(
  sourceType: SyncSourceType,
  filePath: string,
  snapshot: FileSnapshot | undefined,
  result: SyncResult,
  currentOffset: number
): SyncProgressEvent {
  return {
    sourceType,
    filePath,
    fileSize: snapshot?.size ?? 0,
    currentOffset,
    filesConsidered: result.metrics?.filesConsidered ?? 0,
    filesSkippedBeforeParse: result.metrics?.filesSkippedBeforeParse ?? 0,
    filesParsed: result.metrics?.filesParsed ?? 0,
    largestFileBytes: result.metrics?.largestFileBytes ?? 0,
  };
}

function shouldSkipBeforeParse(
  sourceType: SyncSourceType,
  filePath: string,
  snapshot: FileSnapshot,
  opts: SyncSourceOptions
): boolean {
  if (opts.force) return false;

  try {
    const database = getDatabase();
    const existing = database.prepare(`
      SELECT id, file_size, file_mtime, file_hash
      FROM sessions
      WHERE file_path = ?
      ORDER BY last_sync_at DESC
      LIMIT 1
    `).get(filePath) as {
      id: string;
      file_size: number | null;
      file_mtime: string | null;
      file_hash: string | null;
    } | undefined;

    if (existing && getSessionDerivedRowsReparseReason(database, existing.id)) {
      return false;
    }

    return Boolean(
      existing &&
      existing.file_size === snapshot.size &&
      existing.file_mtime === snapshot.mtimeIso &&
      hasCurrentParserCacheHash(sourceType, existing.file_hash)
    );
  } catch {
    return false;
  }
}

function coerceSqlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Write a parsed session to the database
 *
 * Handles session upsert (insert or update) and message insertion.
 * If session already exists, deletes derived rows in dependency order
 * (tool_result_events → tool_calls → turns → messages) and inserts replacements.
 *
 * All writes are wrapped in a single database.transaction() call so partial
 * failures roll back automatically (better-sqlite3 synchronous transactions).
 *
 * Supports skip cache: if sourceFile is provided and its hash matches the
 * stored file_hash, skips the entire parse-and-write operation unless force=true.
 *
 * @param parseResult - Parsed session data from any parser
 * @param db - Optional database connection (defaults to getDatabase())
 * @param sourceFile - Optional file path for hash-based skip cache and file_path column
 * @param options - Optional flags: force=true bypasses hash skip cache
 * @returns SyncResult with counts and errors
 */
export function writeSessionToDatabase(
  parseResult: ParseResult,
  db?: Database.Database,
  sourceFile?: string,
  options?: WriteSessionOptions
): SyncResult {
  const database = db || getDatabase();
  const errors: string[] = [];
  let sessionsInserted = 0;
  let sessionsUpdated = 0;
  let messagesInserted = 0;
  let toolCallsInserted = 0;
  let toolResultEventsInserted = 0;

  try {
    // Compute file hash for skip cache (if sourceFile provided)
    let fileHash: string | null = null;
    let fileSize: number | null = null;
    let fileMtime: string | null = null;
    const lastSyncAt = new Date().toISOString();
    if (sourceFile) {
      const statsPath = options?.sourceFileStatsPath ?? sourceFile;
      if (!options?.cacheFileHash) {
        fileHash = computeFileHash(sourceFile);
      }
      const stats = fs.statSync(statsPath);
      fileSize = stats.size;
      fileMtime = new Date(stats.mtimeMs).toISOString();
    }
    const cacheFileHash = options?.cacheFileHash ?? (fileHash
      ? buildParserCacheHash(parseResult.session.source, fileHash)
      : null);

    // Check if session already exists
    const existing = database.prepare(
      'SELECT id, file_hash, name, project FROM sessions WHERE id = ?'
    ).get(parseResult.session.id) as { id: string; file_hash: string | null; name: string | null; project: string | null } | undefined;
    const parsedProject =
      parseResult.session.project && parseResult.session.project !== 'default'
        ? parseResult.session.project
        : '';

    // Skip cache: if hash matches AND force is not set, skip derived-row writes
    // but still refresh metadata that can be repaired cheaply from the parser.
    const derivedRowsReason = existing
      ? getSessionDerivedRowsReparseReason(database, existing.id)
      : null;
    if (existing && cacheFileHash && existing.file_hash === cacheFileHash && !options?.force && !derivedRowsReason) {
      database.prepare(`
        UPDATE sessions SET
          file_size = ?,
          file_mtime = ?,
          last_sync_at = ?,
          name = CASE WHEN (name IS NULL OR name = '') THEN ? ELSE name END,
          project = COALESCE(NULLIF(?, ''), project),
          cwd = COALESCE(NULLIF(?, ''), cwd),
          git_branch = COALESCE(NULLIF(?, ''), git_branch),
          agent_name = COALESCE(?, agent_name)
        WHERE id = ?
      `).run(
        fileSize,
        fileMtime,
        lastSyncAt,
        parseResult.session.name || '',
        parsedProject,
        parseResult.session.cwd || '',
        parseResult.session.gitBranch || '',
        parseResult.session.agentName || null,
        parseResult.session.id
      );

      return {
        sessionsInserted: 0,
        sessionsUpdated: 0,
        messagesInserted: 0,
        toolCallsInserted: 0,
        toolResultEventsInserted: 0,
        errors: [],
      };
    }

    // Build a lookup: messageOrdinal → tool calls for that message
    // Used to set has_tool_use on message rows.
    const toolCallsByOrdinal = new Map<number, typeof parseResult.activities[number][]>();
    for (const activity of parseResult.activities) {
      if (activity.type !== 'tool_call') continue;
      const ordinal = activity.messageOrdinal;
      if (typeof ordinal === 'number') {
        const list = toolCallsByOrdinal.get(ordinal) ?? [];
        list.push(activity);
        toolCallsByOrdinal.set(ordinal, list);
      }
    }

    const {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens,
    } = getSessionTokenTotals(parseResult);
    const dailyTokenRows = buildDailyTokenRowsForParseResult(parseResult, fileMtime, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens,
    });

    // -------------------------------------------------------------------------
    // Transactional write: all inserts/deletes in a single SQLite transaction
    // -------------------------------------------------------------------------
    const writeTransaction = database.transaction(() => {
      if (existing) {
        // Delete derived rows in dependency order before re-inserting
        // tool_result_events reference tool_calls, so delete events first.
        database.prepare(`
          DELETE FROM tool_result_events
          WHERE tool_call_id IN (
            SELECT id FROM tool_calls WHERE session_id = ?
          )
        `).run(parseResult.session.id);
        database.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(parseResult.session.id);
        database.prepare('DELETE FROM subagent_links WHERE session_id = ?').run(parseResult.session.id);
        database.prepare('DELETE FROM turns WHERE session_id = ?').run(parseResult.session.id);
        database.prepare('DELETE FROM messages WHERE session_id = ?').run(parseResult.session.id);
        database.prepare('DELETE FROM session_token_daily WHERE session_id = ?').run(parseResult.session.id);

        // Update session metadata
        database.prepare(`
          UPDATE sessions SET
            started_at = ?,
            ended_at = ?,
            status = ?,
            message_count = ?,
            user_message_count = ?,
            total_output_tokens = ?,
            total_input_tokens = ?,
            total_cache_read_tokens = ?,
            total_cache_write_tokens = ?,
            total_reasoning_tokens = ?,
            total_tokens = ?,
            has_tool_calls = ?,
            parser_malformed_lines = ?,
            is_truncated = ?,
            termination_status = ?,
            name = ?,
            project = ?,
            root_session_id = ?,
            parent_session_id = ?,
            relationship_type = ?,
            cwd = ?,
            git_branch = ?,
            source_session_id = ?,
            source_version = ?,
            agent_name = ?,
            source_cost_usd = ?,
            cost_source = ?,
            cost_pricing_status = ?,
            file_path = ?,
            file_size = ?,
            file_mtime = ?,
            file_hash = ?,
            last_sync_at = ?
          WHERE id = ?
        `).run(
          parseResult.session.startedAt,
          parseResult.session.endedAt,
          parseResult.session.status,
          parseResult.session.metrics.messageCount,
          parseResult.session.metrics.userMessageCount,
          outputTokens,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
          totalTokens,
          parseResult.session.metrics.hasToolCalls ? 1 : 0,
          parseResult.session.metrics.parserMalformedLines,
          parseResult.session.metrics.isTruncated ? 1 : 0,
          parseResult.session.metrics.terminationStatus || '',
          parseResult.session.name || '',
          parseResult.session.project,
          parseResult.session.rootSessionId || null,
          parseResult.session.parentSessionId || null,
          parseResult.session.relationshipType || 'root',
          parseResult.session.cwd || null,
          parseResult.session.gitBranch || null,
          parseResult.session.sourceSessionId || null,
          parseResult.session.sourceVersion || null,
          parseResult.session.agentName || null,
          parseResult.session.sourceCostUsd ?? null,
          parseResult.session.costSource ?? null,
          parseResult.session.costPricingStatus ?? null,
          sourceFile || parseResult.session.id,
          fileSize,
          fileMtime,
          cacheFileHash,
          lastSyncAt,
          parseResult.session.id
        );
        sessionsUpdated++;
      } else {
        // Insert new session
        database.prepare(`
          INSERT INTO sessions (
            id, source, project, name, started_at, ended_at, status,
            root_session_id, parent_session_id, relationship_type,
            message_count, user_message_count, total_output_tokens, total_input_tokens,
            total_cache_read_tokens, total_cache_write_tokens, total_reasoning_tokens, total_tokens,
            has_tool_calls,
            parser_malformed_lines, is_truncated, termination_status,
            file_path, file_size, file_mtime, file_hash, last_sync_at,
            cwd, git_branch, source_session_id, source_version, agent_name,
            source_cost_usd, cost_source, cost_pricing_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          parseResult.session.id,
          parseResult.session.source,
          parseResult.session.project,
          parseResult.session.name || '',
          parseResult.session.startedAt,
          parseResult.session.endedAt,
          parseResult.session.status,
          parseResult.session.rootSessionId || null,
          parseResult.session.parentSessionId || null,
          parseResult.session.relationshipType || 'root',
          parseResult.session.metrics.messageCount,
          parseResult.session.metrics.userMessageCount,
          outputTokens,
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
          totalTokens,
          parseResult.session.metrics.hasToolCalls ? 1 : 0,
          parseResult.session.metrics.parserMalformedLines,
          parseResult.session.metrics.isTruncated ? 1 : 0,
          parseResult.session.metrics.terminationStatus || '',
          sourceFile || parseResult.session.id,
          fileSize,
          fileMtime,
          cacheFileHash,
          lastSyncAt,
          parseResult.session.cwd || null,
          parseResult.session.gitBranch || null,
          parseResult.session.sourceSessionId || null,
          parseResult.session.sourceVersion || null,
          parseResult.session.agentName || null,
          parseResult.session.sourceCostUsd ?? null,
          parseResult.session.costSource ?? null,
          parseResult.session.costPricingStatus ?? null
        );
        sessionsInserted++;
      }

      insertDailyTokenRows(database, dailyTokenRows);

      // Insert messages with stable IDs
      // ID priority: message.id (from parser) → deterministic fallback "${sessionId}:${ordinal}"
      const insertMessage = database.prepare(`
        INSERT INTO messages (
          id, session_id, ordinal, role, content, timestamp, model,
          has_tool_use, turn_id, turn_index, is_real_user_input,
          token_usage_json, source_file, source_line
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const message of parseResult.messages) {
        const messageId = (message.id && message.id.trim())
          ? message.id
          : `${parseResult.session.id}:${message.ordinal}`;

        const hasToolUse = toolCallsByOrdinal.has(message.ordinal) ? 1 : 0;

        insertMessage.run(
          messageId,
          parseResult.session.id,
          message.ordinal,
          message.role,
          message.content,
          message.timestamp || null,
          message.model || '',
          hasToolUse,
          message.turnId || null,
          typeof message.turnIndex === 'number' ? message.turnIndex : null,
          message.isRealUserInput ? 1 : 0,
          message.tokenUsage ? JSON.stringify(message.tokenUsage) : '',
          message.sourceMetadata.sourceFile,
          message.sourceMetadata.sourceLine || null
        );
        messagesInserted++;
      }

      // Insert tool_calls and tool_result_events
      const insertToolCall = database.prepare(`
        INSERT INTO tool_calls (
          session_id, message_ordinal, tool_id, name, category,
          input_json, status, error, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertResultEvent = database.prepare(`
        INSERT INTO tool_result_events (tool_call_id, timestamp, content, is_partial)
        VALUES (?, ?, ?, ?)
      `);

      const insertSubagentLink = database.prepare(`
        INSERT INTO subagent_links (
          session_id, subagent_session_id, subagent_source, relationship, message_ordinal
        ) VALUES (?, ?, ?, ?, ?)
      `);

      for (const activity of parseResult.activities) {
        if (activity.type !== 'tool_call') continue;

        const tc = activity as import('@/types/trace').TraceToolCall;
        const messageOrdinal = tc.messageOrdinal ?? 0;

        const insertResult = insertToolCall.run(
          parseResult.session.id,
          messageOrdinal,
          tc.id,
          tc.name,
          tc.category || 'Other',
          coerceSqlText(tc.inputJson),
          tc.status,
          tc.error || null,
          tc.durationMs || null
        );
        toolCallsInserted++;

        const toolCallDbId = insertResult.lastInsertRowid;

        // Insert each result event linked to this tool call
        for (const re of tc.resultEvents) {
          insertResultEvent.run(
            toolCallDbId,
            re.timestamp || null,
            coerceSqlText(re.content),
            re.isPartial ? 1 : 0
          );
          toolResultEventsInserted++;
        }
      }

      for (const activity of parseResult.activities) {
        if (activity.type !== 'subagent_link') continue;

        const link = activity as import('@/types/trace').TraceSubagentLink;
        insertSubagentLink.run(
          parseResult.session.id,
          link.subagentSessionId,
          link.subagentSource,
          link.relationship,
          typeof link.messageOrdinal === 'number' ? link.messageOrdinal : null
        );
      }
    });

    writeTransaction();

    // Emit SSE events for real-time frontend invalidation (outside transaction)
    if (existing) {
      sseManager.emit('session_updated', {
        sessionId: parseResult.session.id,
        source: parseResult.session.source,
      });
      sseManager.emitSessionEvent(parseResult.session.id, 'session_updated', {});
    } else {
      sseManager.emit('session_created', {
        sessionId: parseResult.session.id,
        source: parseResult.session.source,
      });
      sseManager.emitSessionEvent(parseResult.session.id, 'session_created', {});
    }

  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Unknown error');
  }

  return {
    sessionsInserted,
    sessionsUpdated,
    messagesInserted,
    toolCallsInserted,
    toolResultEventsInserted,
    errors
  };
}

export function appendSessionDeltaToDatabase(
  delta: IncrementalParseDelta,
  db: Database.Database,
  sourceFile: string,
  decision: Extract<CursorDecision, { type: 'incremental_append' }>
): SyncResult {
  const errors: string[] = [];
  let sessionsInserted = 0;
  let sessionsUpdated = 0;
  let messagesInserted = 0;
  let toolCallsInserted = 0;
  let toolResultEventsInserted = 0;

  try {
    const lastSyncAt = new Date().toISOString();
    const sessionId = delta.sessionId;
    const existingSession = db
      .prepare('SELECT id, project FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; project: string | null } | undefined;
    const projectPatch =
      delta.sessionPatch.project && delta.sessionPatch.project !== 'default'
        ? delta.sessionPatch.project
        : '';
    const effectiveProject = projectPatch || existingSession?.project || 'default';
    const toolCallsByOrdinal = new Map<number, IncrementalParseDelta['toolCalls']>();
    for (const toolCall of delta.toolCalls) {
      if (typeof toolCall.messageOrdinal !== 'number') continue;
      const list = toolCallsByOrdinal.get(toolCall.messageOrdinal) ?? [];
      list.push(toolCall);
      toolCallsByOrdinal.set(toolCall.messageOrdinal, list);
    }
    let insertedUserMessages = 0;
    let insertedInputTokens = 0;
    let insertedOutputTokens = 0;
    let insertedCacheReadTokens = 0;
    let insertedCacheWriteTokens = 0;
    let insertedReasoningTokens = 0;
    let insertedTotalTokens = 0;
    const insertedDailyRows = new Map<string, DailyTokenRollupRow>();

    const writeTransaction = db.transaction(() => {
      if (existingSession) {
        db.prepare(`
          UPDATE sessions SET
            project = COALESCE(NULLIF(?, ''), project),
            ended_at = COALESCE(?, ended_at),
            status = COALESCE(?, status),
            cwd = COALESCE(?, cwd),
            git_branch = COALESCE(?, git_branch),
            source_session_id = COALESCE(?, source_session_id),
            source_version = COALESCE(?, source_version),
            file_path = ?,
            file_size = ?,
            file_mtime = ?,
            last_sync_at = ?
          WHERE id = ?
        `).run(
          projectPatch,
          delta.sessionPatch.endedAt || null,
          delta.sessionPatch.status || null,
          delta.sessionPatch.cwd || null,
          delta.sessionPatch.gitBranch || null,
          delta.sessionPatch.sourceSessionId || null,
          delta.sessionPatch.sourceVersion || null,
          sourceFile,
          decision.snapshot.size,
          decision.snapshot.mtimeIso,
          lastSyncAt,
          sessionId
        );
        sessionsUpdated++;
      } else {
        db.prepare(`
          INSERT INTO sessions (
            id, source, project, started_at, ended_at, status,
            message_count, user_message_count, total_output_tokens, total_input_tokens,
            has_tool_calls, parser_malformed_lines, is_truncated,
            file_path, file_size, file_mtime, last_sync_at,
            cwd, git_branch, source_session_id, source_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionId,
          delta.sourceType,
          projectPatch || 'default',
          delta.sessionPatch.startedAt || null,
          delta.sessionPatch.endedAt || null,
          delta.sessionPatch.status || 'idle',
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          sourceFile,
          decision.snapshot.size,
          decision.snapshot.mtimeIso,
          lastSyncAt,
          delta.sessionPatch.cwd || null,
          delta.sessionPatch.gitBranch || null,
          delta.sessionPatch.sourceSessionId || sessionId,
          delta.sessionPatch.sourceVersion || null
        );
        sessionsInserted++;
      }

      const insertMessage = db.prepare(`
        INSERT OR IGNORE INTO messages (
          id, session_id, ordinal, role, content, timestamp, model,
          has_tool_use, turn_id, turn_index, is_real_user_input,
          token_usage_json, source_file, source_line
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const message of delta.messages) {
        const messageId = (message.id && message.id.trim())
          ? message.id
          : `${sessionId}:${message.ordinal}`;
        const result = insertMessage.run(
          messageId,
          sessionId,
          message.ordinal,
          message.role,
          message.content,
          message.timestamp || null,
          message.model || '',
          toolCallsByOrdinal.has(message.ordinal) ? 1 : 0,
          message.turnId || null,
          typeof message.turnIndex === 'number' ? message.turnIndex : null,
          message.isRealUserInput ? 1 : 0,
          message.tokenUsage ? JSON.stringify(message.tokenUsage) : '',
          message.sourceMetadata.sourceFile,
          message.sourceMetadata.sourceLine || null
        );
        messagesInserted += result.changes;
        if (result.changes > 0) {
          if (message.role === 'user') insertedUserMessages++;
          const usage = message.tokenUsage;
          if (usage) {
            insertedInputTokens += usage.inputTokens;
            insertedOutputTokens += usage.outputTokens;
            insertedCacheReadTokens += usage.cacheReadTokens ?? 0;
            insertedCacheWriteTokens += usage.cacheWriteTokens ?? 0;
            insertedReasoningTokens += usage.reasoningTokens ?? 0;
            insertedTotalTokens += usage.totalTokens
              ?? usage.inputTokens
                + usage.outputTokens
                + (usage.cacheReadTokens ?? 0)
                + (usage.cacheWriteTokens ?? 0)
                + (usage.reasoningTokens ?? 0);
            addDailyTokenRollup(insertedDailyRows, {
              sessionId,
              source: delta.sourceType,
              project: effectiveProject,
              timestamp: message.timestamp,
              fallbackTimestamp: decision.snapshot.mtimeIso,
              attribution: 'message',
              totals: normalizeTokenUsage(usage),
            });
          }
        }
      }

      const upsertToolCall = db.prepare(`
        INSERT INTO tool_calls (
          session_id, message_ordinal, tool_id, name, category,
          input_json, status, error, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, tool_id) DO UPDATE SET
          message_ordinal = excluded.message_ordinal,
          name = excluded.name,
          category = excluded.category,
          input_json = excluded.input_json,
          status = excluded.status,
          error = excluded.error,
          duration_ms = excluded.duration_ms
      `);
      const insertResultEvent = db.prepare(`
        INSERT OR IGNORE INTO tool_result_events (tool_call_id, timestamp, content, is_partial)
        VALUES (?, ?, ?, ?)
      `);
      const getToolCallId = db.prepare(`
        SELECT id FROM tool_calls WHERE session_id = ? AND tool_id = ?
      `);

      for (const toolCall of delta.toolCalls) {
        const result = upsertToolCall.run(
          sessionId,
          toolCall.messageOrdinal ?? 0,
          toolCall.id,
          toolCall.name,
          toolCall.category || 'Other',
          coerceSqlText(toolCall.inputJson),
          toolCall.status,
          toolCall.error || null,
          toolCall.durationMs || null
        );
        toolCallsInserted += result.changes;
        const row = getToolCallId.get(sessionId, toolCall.id) as { id: number } | undefined;
        if (!row) continue;

        for (const event of toolCall.resultEvents) {
          const eventResult = insertResultEvent.run(
            row.id,
            event.timestamp || null,
            coerceSqlText(event.content),
            event.isPartial ? 1 : 0
          );
          toolResultEventsInserted += eventResult.changes;
        }
      }

      for (const event of delta.toolResultEvents) {
        const row = getToolCallId.get(sessionId, event.toolId) as { id: number } | undefined;
        if (!row) {
          throw new Error(`Missing tool call for result event: ${event.toolId}`);
        }
        const eventResult = insertResultEvent.run(
          row.id,
          event.event.timestamp || null,
          coerceSqlText(event.event.content),
          event.event.isPartial ? 1 : 0
        );
        toolResultEventsInserted += eventResult.changes;
      }

      const insertSubagentLink = db.prepare(`
        INSERT OR IGNORE INTO subagent_links (
          session_id, subagent_session_id, subagent_source, relationship, message_ordinal
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const link of delta.subagentLinks) {
        insertSubagentLink.run(
          sessionId,
          link.subagentSessionId,
          link.subagentSource,
          link.relationship,
          typeof link.messageOrdinal === 'number' ? link.messageOrdinal : null
        );
      }

      const existingCursor = db.prepare(`
        SELECT last_indexed_offset, last_indexed_line
        FROM ingest_file_cursors
        WHERE source_type = ? AND file_path = ?
      `).get(delta.sourceType, sourceFile) as
        | { last_indexed_offset: number; last_indexed_line: number }
        | undefined;
      const cursorAdvanced =
        !existingCursor ||
        delta.cursorUpdate.lastIndexedOffset > existingCursor.last_indexed_offset ||
        (
          delta.cursorUpdate.lastIndexedOffset === existingCursor.last_indexed_offset &&
          delta.cursorUpdate.lastIndexedLine > existingCursor.last_indexed_line
        );
      const parserTotalDelta = delta.metricsDelta.totalTokens
        ?? delta.metricsDelta.totalInputTokens
          + delta.metricsDelta.totalOutputTokens
          + (delta.metricsDelta.totalCacheReadTokens ?? 0)
          + (delta.metricsDelta.totalCacheWriteTokens ?? 0)
          + (delta.metricsDelta.totalReasoningTokens ?? 0);
      const tokenInputDelta = cursorAdvanced ? delta.metricsDelta.totalInputTokens : insertedInputTokens;
      const tokenOutputDelta = cursorAdvanced ? delta.metricsDelta.totalOutputTokens : insertedOutputTokens;
      const tokenCacheReadDelta = cursorAdvanced ? (delta.metricsDelta.totalCacheReadTokens ?? 0) : insertedCacheReadTokens;
      const tokenCacheWriteDelta = cursorAdvanced ? (delta.metricsDelta.totalCacheWriteTokens ?? 0) : insertedCacheWriteTokens;
      const tokenReasoningDelta = cursorAdvanced ? (delta.metricsDelta.totalReasoningTokens ?? 0) : insertedReasoningTokens;
      const tokenTotalDelta = cursorAdvanced ? parserTotalDelta : insertedTotalTokens;
      const dailyRows = cursorAdvanced
        ? buildDailyTokenRowsForDelta(delta, effectiveProject, decision.snapshot.mtimeIso)
        : [...insertedDailyRows.values()];

      db.prepare(`
        UPDATE sessions SET
          message_count = message_count + ?,
          user_message_count = user_message_count + ?,
          total_output_tokens = COALESCE(total_output_tokens, 0) + ?,
          total_input_tokens = COALESCE(total_input_tokens, 0) + ?,
          total_cache_read_tokens = COALESCE(total_cache_read_tokens, 0) + ?,
          total_cache_write_tokens = COALESCE(total_cache_write_tokens, 0) + ?,
          total_reasoning_tokens = COALESCE(total_reasoning_tokens, 0) + ?,
          total_tokens = COALESCE(total_tokens, 0) + ?,
          has_tool_calls = CASE WHEN ? THEN 1 ELSE has_tool_calls END,
          parser_malformed_lines = parser_malformed_lines + ?
        WHERE id = ?
      `).run(
        messagesInserted,
        insertedUserMessages,
        tokenOutputDelta,
        tokenInputDelta,
        tokenCacheReadDelta,
        tokenCacheWriteDelta,
        tokenReasoningDelta,
        tokenTotalDelta,
        toolCallsInserted > 0 || toolResultEventsInserted > 0 || delta.toolResultEvents.length > 0 ? 1 : 0,
        cursorAdvanced ? delta.metricsDelta.parserMalformedLines : 0,
        sessionId
      );

      addDailyTokenRows(db, dailyRows);

      upsertIngestFileCursor(db, {
        sourceType: delta.sourceType,
        filePath: sourceFile,
        sessionId,
        snapshot: decision.snapshot,
        lastIndexedOffset: delta.cursorUpdate.lastIndexedOffset,
        lastIndexedLine: delta.cursorUpdate.lastIndexedLine,
        lastMessageOrdinal: delta.cursorUpdate.lastMessageOrdinal,
        lastTurnIndex: delta.cursorUpdate.lastTurnIndex,
        fallbackReason: null,
      });
    });

    writeTransaction();

    sseManager.emit('session_updated', {
      sessionId,
      source: delta.sourceType,
    });
    sseManager.emitSessionEvent(sessionId, 'session_updated', {});
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Unknown error');
  }

  return {
    sessionsInserted,
    sessionsUpdated,
    messagesInserted,
    toolCallsInserted,
    toolResultEventsInserted,
    errors,
  };
}

// ============================================================================
// Source Sync Orchestration
// ============================================================================

/**
 * Upsert sync status into the sync_status table after a sync operation.
 *
 * Tracks last sync timestamp, files watched, and error state per source type.
 * Uses INSERT OR REPLACE for idempotent upserts.
 */
function upsertSyncStatus(sourceType: string, result: SyncResult): void {
  try {
    const database = getDatabase();
    const filesWatched = result.sessionsInserted + result.sessionsUpdated;
    const lastError = result.errors.length > 0 ? result.errors[0] : null;

    database.prepare(`
      INSERT OR REPLACE INTO sync_status
        (source_type, last_full_sync_at, last_watch_sync_at, files_watched, last_error)
      VALUES (?, datetime('now'), NULL, ?, ?)
    `).run(sourceType, filesWatched, lastError);
  } catch (err) {
    logger.error(`[sync_status] Failed to upsert sync status for ${sourceType}:`, err);
  }
}

/**
 * Options for syncSource
 */
export interface SyncSourceOptions {
  /** Base path override for source discovery (OpenClaw only) */
  basePath?: string;
  /** Force reparse — bypasses file_hash skip cache; reparses all session files */
  force?: boolean;
  /** Maximum number of session files to parse for this sync call */
  limit?: number;
  /** Sort candidate files by newest mtime before applying limit */
  sortByMtimeDesc?: boolean;
  /** Internal progress reporter used by the scheduler/debug endpoint. */
  observer?: SyncObserver;
}

interface SyncFileCandidate {
  filePath: string;
  project: string;
  mtimeMs: number;
}

export type CodexRelationship = { parentSessionId: string; rootSessionId?: string };
export type CodexRelationshipsByChild = Map<string, CodexRelationship>;

interface IncrementalParserContext {
  currentTurnId?: string;
  currentModel?: string;
  knownToolCallIds: string[];
}

function isSessionFileName(sourceType: SyncSourceType, fileName: string): boolean {
  if (sourceType !== 'openclaw') return fileName.endsWith('.jsonl');
  if (fileName.endsWith('.jsonl')) return true;
  const idx = fileName.indexOf('.jsonl.');
  if (idx <= 0) return false;
  const suffix = fileName.slice(idx + 7); // after ".jsonl."
  return suffix.startsWith('deleted.') || suffix.startsWith('reset.') || suffix === 'full.bak';
}

async function collectSessionFileCandidates(
  sources: Array<{ path: string; error?: string; sessionCount: number }>,
  sourceType: SyncSourceType,
  opts: SyncSourceOptions
): Promise<SyncFileCandidate[]> {
  const fsp = await import('fs/promises');
  const candidates: SyncFileCandidate[] = [];

  for (const source of sources) {
    if (source.error || source.sessionCount === 0) continue;

    let files: string[];
    try {
      files = await fsp.readdir(source.path);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!isSessionFileName(sourceType, file)) continue;

      const filePath = path.join(source.path, file);
      let mtimeMs = 0;
      if (opts.sortByMtimeDesc || typeof opts.limit === 'number') {
        try {
          const stats = await fsp.stat(filePath);
          mtimeMs = stats.mtimeMs;
        } catch {
          // Keep candidate with lowest priority; parser will report read errors.
        }
      }

      candidates.push({
        filePath,
        project: extractProjectFromPath(filePath, sourceType),
        mtimeMs,
      });
    }
  }

  if (opts.sortByMtimeDesc || typeof opts.limit === 'number') {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
  }

  if (typeof opts.limit === 'number') {
    return candidates.slice(0, Math.max(0, opts.limit));
  }

  return candidates;
}

/**
 * Sync all sessions from a source type
 *
 * Orchestrates full sync pipeline: discover sources → parse files → write to database.
 * Supports OpenClaw, Claude Code, Codex, and Qoder source types.
 *
 * @param sourceType - Type of source to sync ('openclaw', 'claude-code', 'codex', 'qoder')
 * @param options - Optional sync options (basePath, force)
 * @returns SyncResult with aggregated counts and errors
 */
export async function syncSource(
  sourceType: SyncSourceType,
  options?: SyncSourceOptions | string
): Promise<SyncResult> {
  // Backward-compatible: accept legacy string argument as basePath
  const opts: SyncSourceOptions = typeof options === 'string'
    ? { basePath: options }
    : (options ?? {});

  let result: SyncResult;

  // D-21 (Plan 01): Enumerated source types only — unknown sources have no parser
  if (sourceType === 'openclaw') {
    result = await syncOpenClawSource(opts);
  } else if (sourceType === 'claude-code') {
    result = await syncClaudeCodeSource(opts);
  } else if (sourceType === 'codex') {
    result = await syncCodexSource(opts);
  } else if (sourceType === 'opencode') {
    result = await syncOpencodeSource(opts);
  } else if (sourceType === 'qoder') {
    result = await syncQoderSource(opts);
  } else {
    result = {
      sessionsInserted: 0,
      sessionsUpdated: 0,
      messagesInserted: 0,
      toolCallsInserted: 0,
      toolResultEventsInserted: 0,
      errors: [`Unknown source type: ${sourceType}`],
    };
  }

  // Upsert sync_status table after each sync operation (Phase 6)
  upsertSyncStatus(sourceType, result);

  return result;
}

function isWithinRoot(candidatePath: string, allowedRoot: string): boolean {
  const resolved = path.resolve(candidatePath);
  const root = path.resolve(allowedRoot);
  return resolved === root || resolved.startsWith(root + path.sep);
}

async function collectPathFileCandidates(
  sourceType: SyncSourceType,
  paths: string[]
): Promise<SyncFileCandidate[]> {
  const { getConfig } = await import('../config');
  const roots = getConfig().toolDirs.get(sourceType) ?? [];
  const candidates: SyncFileCandidate[] = [];

  for (const rawPath of Array.from(new Set(paths))) {
    const filePath = path.resolve(rawPath);
    const fileName = path.basename(filePath);

    if (!isSessionFileName(sourceType, fileName)) continue;
    if (roots.length > 0 && !roots.some((root) => isWithinRoot(filePath, root))) continue;
    if (!fs.existsSync(filePath)) continue;

    candidates.push({
      filePath,
      project: extractProjectFromPath(filePath, sourceType),
      mtimeMs: 0,
    });
  }

  return candidates.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

async function parseAndWriteCandidate(
  sourceType: SyncSourceType,
  candidate: SyncFileCandidate,
  opts: SyncSourceOptions,
  totalResult: SyncResult,
  relationshipsByChild: CodexRelationshipsByChild = new Map()
): Promise<void> {
  const filePath = candidate.filePath;
  const snapshot = tryGetFileSnapshot(filePath);
  recordFileConsidered(totalResult, snapshot);
  opts.observer?.onFileStart?.(buildProgressEvent(sourceType, filePath, snapshot, totalResult, 0));

  if (snapshot && shouldSkipBeforeParse(sourceType, filePath, snapshot, opts)) {
    recordFileSkippedBeforeParse(totalResult);
    opts.observer?.onFileComplete?.(
      buildProgressEvent(sourceType, filePath, snapshot, totalResult, snapshot.size)
    );
    return;
  }

  let fullReparseReason: string | null = null;
  if (sourceType !== 'openclaw') {
    const decision = decideCursorSync(sourceType, filePath, snapshot, opts);
    if (decision.type === 'skip_unchanged') {
      recordFileSkippedBeforeParse(totalResult);
      opts.observer?.onFileComplete?.(
        buildProgressEvent(sourceType, filePath, snapshot, totalResult, snapshot?.size ?? 0)
      );
      return;
    }

    if (decision.type === 'incremental_append') {
      opts.observer?.onFileProgress?.(
        buildProgressEvent(sourceType, filePath, snapshot, totalResult, decision.startOffset)
      );
      const incrementalResult = await parseIncrementalAppendCandidate(
        sourceType,
        candidate,
        decision,
        totalResult,
        relationshipsByChild
      );
      if (incrementalResult.handled) {
        opts.observer?.onFileComplete?.(
          buildProgressEvent(sourceType, filePath, snapshot, totalResult, decision.endOffset)
        );
        return;
      }
      fullReparseReason = incrementalResult.fallbackReason || 'incremental_append_fallback';
    } else {
      fullReparseReason = decision.reason;
    }
  }

  await parseFullCandidate(
    sourceType,
    candidate,
    opts,
    totalResult,
    relationshipsByChild,
    fullReparseReason
  );
  opts.observer?.onFileComplete?.(
    buildProgressEvent(sourceType, filePath, snapshot, totalResult, snapshot?.size ?? 0)
  );
}

async function parseFullCandidate(
  sourceType: SyncSourceType,
  candidate: SyncFileCandidate,
  opts: SyncSourceOptions,
  totalResult: SyncResult,
  relationshipsByChild: CodexRelationshipsByChild = new Map(),
  fallbackReason: string | null = null
): Promise<void> {
  const filePath = candidate.filePath;

  if (sourceType === 'openclaw') {
    const { parseOpenClawSession } = await import('../parser/openclaw');
    const parseResult = await parseOpenClawSession(filePath, candidate.project);
    recordFileParsed(totalResult, 'full');
    parseResult.session.name = extractSessionName(parseResult);
    parseResult.session.project = extractProjectFromParsedSession(parseResult, candidate.project);
    parseResult.session.agentName = extractAgentNameFromPath(filePath, 'openclaw');
    const writeResult = writeSessionToDatabase(parseResult, undefined, filePath, { force: opts.force });
    if (writeResult.errors.length === 0) {
      const database = getDatabase();
      updateCursorAfterFullParse(database, sourceType, filePath, parseResult, fallbackReason);
    }
    mergeSyncResult(totalResult, writeResult);
    return;
  }

  if (sourceType === 'claude-code') {
    const { parseClaudeSession } = await import('../parser/claude');
    const parseResult = await parseClaudeSession(filePath, candidate.project);
    recordFileParsed(totalResult, 'full');
    parseResult.session.name = extractSessionName(parseResult);
    parseResult.session.project = extractProjectFromParsedSession(parseResult, candidate.project);
    if (parseResult.errors.length > 0) {
      logger.warn(
        `[sync:claude-code] ${parseResult.errors.length} parse error(s) in ${filePath}:`,
        parseResult.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.error}`)
      );
    }
    const writeResult = writeSessionToDatabase(parseResult, undefined, filePath, { force: opts.force });
    if (writeResult.errors.length > 0) {
      logger.error(
        `[sync:claude-code] DB write failed, session not stored: ${filePath}:`,
        writeResult.errors.slice(0, 5)
      );
    }
    if (writeResult.errors.length === 0) {
      const database = getDatabase();
      updateCursorAfterFullParse(database, sourceType, filePath, parseResult, fallbackReason);
    }
    mergeSyncResult(totalResult, writeResult);
    return;
  }

  if (sourceType === 'opencode') {
    return;
  }

  // Qoder uses session-keyed rows from a SQLite database, not one JSONL file
  // per session. This fallback supports logical candidates shaped as
  // "<dbPath>#<rawSessionId>"; normal Qoder sync goes through syncQoderSource.
  if (sourceType === 'qoder') {
    const { parseQoderSession, computeQoderSessionFingerprint } = await import('../parser/qoder');
    const [dbPath, rawSessionIdFromPath] = filePath.split('#');
    const qoderSessionId = rawSessionIdFromPath || path.basename(filePath, path.extname(filePath));
    const qoderResult = await parseQoderSession(dbPath, qoderSessionId);
    recordFileParsed(totalResult, 'full');

    let fingerprintRow: { gmt_modified: number; msg_count: number; max_msg_gmt: number | null } | undefined;
    let qoderDb: Database.Database | null = null;
    try {
      qoderDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      fingerprintRow = qoderDb.prepare(
        `SELECT gmt_modified,
                (SELECT COUNT(*) FROM chat_message m WHERE m.session_id = chat_session.session_id) AS msg_count,
                (SELECT MAX(gmt_create) FROM chat_message m WHERE m.session_id = chat_session.session_id) AS max_msg_gmt
         FROM chat_session
         WHERE session_id = ?`
      ).get(qoderSessionId) as { gmt_modified: number; msg_count: number; max_msg_gmt: number | null } | undefined;
    } finally {
      qoderDb?.close();
    }

    const fingerprint = computeQoderSessionFingerprint({
      id: qoderSessionId,
      gmt_modified: fingerprintRow?.gmt_modified ?? 0,
      msg_count: fingerprintRow?.msg_count ?? qoderResult.messages.length,
      max_msg_gmt: fingerprintRow?.max_msg_gmt ?? null,
    });
    const writeResult = writeSessionToDatabase(qoderResult, undefined, filePath, {
      force: opts.force,
      cacheFileHash: buildParserCacheHash('qoder', fingerprint),
      sourceFileStatsPath: dbPath,
    });
    mergeSyncResult(totalResult, writeResult);
    return;
  }

  const { parseCodexSession } = await import('../parser/codex');
  const parseResult = await parseCodexSession(filePath, candidate.project);
  recordFileParsed(totalResult, 'full');
  applyCodexRelationshipToSession(parseResult, relationshipsByChild);
  parseResult.session.name = extractSessionName(parseResult);
  parseResult.session.project = extractProjectFromParsedSession(parseResult, candidate.project);
  const writeResult = writeSessionToDatabase(parseResult, undefined, filePath, { force: opts.force });
  if (writeResult.errors.length === 0) {
    recordCodexRelationshipsFromParseResult(parseResult, relationshipsByChild);
    const database = getDatabase();
    updateCursorAfterFullParse(database, sourceType, filePath, parseResult, fallbackReason);
  }
  mergeSyncResult(totalResult, writeResult);
}

async function parseIncrementalAppendCandidate(
  sourceType: Exclude<SyncSourceType, 'openclaw'>,
  candidate: SyncFileCandidate,
  decision: Extract<CursorDecision, { type: 'incremental_append' }>,
  totalResult: SyncResult,
  relationshipsByChild: CodexRelationshipsByChild = new Map()
): Promise<{ handled: boolean; fallbackReason?: string }> {
  const filePath = candidate.filePath;
  const parserContext = readIncrementalParserContext(decision.cursor);
  const options = {
    startOffset: decision.startOffset,
    endOffset: decision.endOffset,
    startLine: decision.startLine,
    startOrdinal: decision.startOrdinal,
    startTurnIndex: decision.startTurnIndex,
    sessionId: decision.cursor.sessionId || undefined,
    currentTurnId: parserContext.currentTurnId,
    currentModel: parserContext.currentModel,
    knownToolCallIds: parserContext.knownToolCallIds,
    parserVersion: PARSER_CACHE_VERSION,
  };

  const delta: IncrementalParseDelta = sourceType === 'claude-code'
    ? await (await import('../parser/claude')).parseClaudeSessionAppend(
        filePath,
        candidate.project,
        options
      )
    : await (await import('../parser/codex')).parseCodexSessionAppend(
        filePath,
        candidate.project,
        options
      );

  if (delta.requiresFullReparse) {
    recordIncrementalFallback(totalResult);
    return { handled: false, fallbackReason: delta.fallbackReason || 'incremental_parser_fallback' };
  }

  const writeResult = appendSessionDeltaToDatabase(delta, getDatabase(), filePath, decision);
  if (writeResult.errors.length > 0) {
    recordIncrementalFallback(totalResult);
    return { handled: false, fallbackReason: `append_writer_failed:${writeResult.errors[0]}` };
  }

  if (sourceType === 'codex') {
    recordCodexRelationshipsFromDelta(delta, relationshipsByChild);
  }
  recordFileParsed(totalResult, 'incremental');
  mergeSyncResult(totalResult, writeResult);
  return { handled: true };
}

function readIncrementalParserContext(cursor: IngestFileCursor): IncrementalParserContext {
  if (!cursor.sessionId) {
    return { knownToolCallIds: [] };
  }

  try {
    const database = getDatabase();
    const message = database.prepare(`
      SELECT turn_id, model
      FROM messages
      WHERE session_id = ?
      ORDER BY ordinal DESC
      LIMIT 1
    `).get(cursor.sessionId) as { turn_id: string | null; model: string | null } | undefined;
    const toolRows = database.prepare(`
      SELECT tool_id
      FROM tool_calls
      WHERE session_id = ?
    `).all(cursor.sessionId) as { tool_id: string }[];

    return {
      currentTurnId: message?.turn_id || undefined,
      currentModel: message?.model || undefined,
      knownToolCallIds: toolRows.map((row) => row.tool_id).filter(Boolean),
    };
  } catch {
    return { knownToolCallIds: [] };
  }
}

function rememberCodexRelationship(
  relationshipsByChild: CodexRelationshipsByChild,
  childSessionId: unknown,
  parentSessionId: unknown,
  rootSessionId?: unknown
): void {
  if (
    typeof childSessionId !== 'string' ||
    typeof parentSessionId !== 'string' ||
    childSessionId.length === 0 ||
    parentSessionId.length === 0 ||
    childSessionId === parentSessionId
  ) {
    return;
  }

  relationshipsByChild.set(childSessionId, {
    parentSessionId,
    rootSessionId: typeof rootSessionId === 'string' && rootSessionId.length > 0
      ? rootSessionId
      : parentSessionId,
  });
}

function recordCodexRelationshipsFromParseResult(
  parseResult: ParseResult,
  relationshipsByChild: CodexRelationshipsByChild
): void {
  const parentSessionId = parseResult.session.id;
  const rootSessionId = parseResult.session.rootSessionId || parentSessionId;

  for (const activity of parseResult.activities) {
    if (activity.type !== 'subagent_link') continue;
    if (activity.subagentSource !== 'codex') continue;

    rememberCodexRelationship(
      relationshipsByChild,
      activity.subagentSessionId,
      parentSessionId,
      rootSessionId
    );
  }
}

function recordCodexRelationshipsFromDelta(
  delta: IncrementalParseDelta,
  relationshipsByChild: CodexRelationshipsByChild
): void {
  const parentSessionId = delta.sessionId;
  const rootSessionId = delta.sessionPatch.rootSessionId || parentSessionId;

  for (const link of delta.subagentLinks) {
    if (link.subagentSource !== 'codex') continue;

    rememberCodexRelationship(
      relationshipsByChild,
      link.subagentSessionId,
      parentSessionId,
      rootSessionId
    );
  }
}

function lookupCodexRelationshipFromDatabase(childSessionId: string): CodexRelationship | undefined {
  try {
    const row = getDatabase().prepare(`
      SELECT
        links.session_id AS parent_session_id,
        COALESCE(NULLIF(parent.root_session_id, ''), links.session_id) AS root_session_id
      FROM subagent_links links
      LEFT JOIN sessions parent
        ON parent.id = links.session_id
       AND parent.source = 'codex'
      WHERE links.subagent_source = 'codex'
        AND links.subagent_session_id = ?
      ORDER BY links.id DESC
      LIMIT 1
    `).get(childSessionId) as {
      parent_session_id: string | null;
      root_session_id: string | null;
    } | undefined;

    if (!row?.parent_session_id || row.parent_session_id === childSessionId) {
      return undefined;
    }

    return {
      parentSessionId: row.parent_session_id,
      rootSessionId: row.root_session_id || row.parent_session_id,
    };
  } catch {
    return undefined;
  }
}

function collectCodexRelationshipsFromStoredLinks(
  database: Database.Database,
  relationshipsByChild: CodexRelationshipsByChild = new Map()
): CodexRelationshipsByChild {
  const rows = database.prepare(`
    SELECT
      links.subagent_session_id AS child_session_id,
      links.session_id AS parent_session_id,
      COALESCE(NULLIF(parent.root_session_id, ''), links.session_id) AS root_session_id
    FROM subagent_links links
    LEFT JOIN sessions parent
      ON parent.id = links.session_id
     AND parent.source = 'codex'
    WHERE links.subagent_source = 'codex'
  `).all() as Array<{
    child_session_id: string | null;
    parent_session_id: string | null;
    root_session_id: string | null;
  }>;

  for (const row of rows) {
    rememberCodexRelationship(
      relationshipsByChild,
      row.child_session_id,
      row.parent_session_id,
      row.root_session_id || row.parent_session_id || undefined
    );
  }

  return relationshipsByChild;
}

function applyCodexRelationshipToSession(
  parseResult: ParseResult,
  relationshipsByChild: CodexRelationshipsByChild
): void {
  const relationship = relationshipsByChild.get(parseResult.session.id)
    ?? lookupCodexRelationshipFromDatabase(parseResult.session.id);

  if (!relationship) return;

  parseResult.session.parentSessionId = relationship.parentSessionId;
  parseResult.session.rootSessionId = relationship.rootSessionId || relationship.parentSessionId;
  parseResult.session.relationshipType = 'subagent';
  parseResult.session.sourceSessionId = parseResult.session.sourceSessionId || parseResult.session.id;
}

/**
 * Sync only explicitly changed session file paths for a source type.
 *
 * This is the watcher hot path: it intentionally avoids source-wide discovery,
 * source-wide Codex relationship collection, and full history parsing for
 * unrelated files.
 */
export async function syncPaths(
  sourceType: SyncSourceType,
  paths: string[],
  options?: SyncSourceOptions
): Promise<SyncResult> {
  const opts = options ?? {};
  const totalResult = createSyncResult();
  const relationshipsByChild: CodexRelationshipsByChild = new Map();

  try {
    const candidates = await collectPathFileCandidates(sourceType, paths);
    for (const candidate of candidates) {
      try {
        await parseAndWriteCandidate(sourceType, candidate, opts, totalResult, relationshipsByChild);
      } catch (err) {
        totalResult.errors.push(`Failed to sync changed ${sourceType} path ${candidate.filePath}: ${err}`);
      }
    }
  } catch (err) {
    totalResult.errors.push(`Failed to collect changed ${sourceType} paths: ${err}`);
  }

  if (sourceType === 'codex') {
    try {
      collectCodexRelationshipsFromStoredLinks(getDatabase(), relationshipsByChild);
      if (relationshipsByChild.size > 0) {
        backfillCodexRelationships(getDatabase(), relationshipsByChild);
      }
    } catch (err) {
      totalResult.errors.push(`Codex relationship backfill failed: ${err}`);
    }
  }

  upsertSyncStatus(sourceType, totalResult);
  sseManager.emit('sync_complete', {
    source: sourceType,
    sessionsInserted: totalResult.sessionsInserted,
    sessionsUpdated: totalResult.sessionsUpdated,
    errors: totalResult.errors.length,
  });

  return totalResult;
}

// ============================================================================
// OpenClaw Sync (preserved from Phase 2)
// ============================================================================

/**
 * Sync OpenClaw sessions
 *
 * Uses discoverOpenClawSources() and parseOpenClawSession() from the parser module.
 * This is the original sync path preserved from Phase 2.
 */
async function syncOpenClawSource(opts: SyncSourceOptions): Promise<SyncResult> {
  const { discoverOpenClawSources } = await import('./sources');
  const { parseOpenClawSession } = await import('../parser/openclaw');

  const { getConfig } = await import('../config');
  const toolDirs = getConfig().toolDirs;
  const dirs = opts.basePath ? [opts.basePath] : toolDirs.get('openclaw');
  const sources = await discoverOpenClawSources(dirs);
  const totalResult = createSyncResult();

  try {
    const candidates = await collectSessionFileCandidates(sources, 'openclaw', opts);

    for (const candidate of candidates) {
      const filePath = candidate.filePath;

      try {
        const snapshot = tryGetFileSnapshot(filePath);
        recordFileConsidered(totalResult, snapshot);
        if (snapshot && shouldSkipBeforeParse('openclaw', filePath, snapshot, opts)) {
          recordFileSkippedBeforeParse(totalResult);
          continue;
        }

        const parseResult = await parseOpenClawSession(filePath, candidate.project);
        recordFileParsed(totalResult);
        parseResult.session.name = extractSessionName(parseResult);
        parseResult.session.project = extractProjectFromParsedSession(parseResult, candidate.project);
        parseResult.session.agentName = extractAgentNameFromPath(filePath, 'openclaw')
        const result = writeSessionToDatabase(parseResult, undefined, filePath, { force: opts.force });
        mergeSyncResult(totalResult, result);
      } catch (err) {
        totalResult.errors.push(`Failed to parse ${filePath}: ${err}`);
      }
    }
  } catch (err) {
    totalResult.errors.push(`Failed to collect OpenClaw session files: ${err}`);
  }

  sseManager.emit('sync_complete', {
    source: 'openclaw',
    sessionsInserted: totalResult.sessionsInserted,
    sessionsUpdated: totalResult.sessionsUpdated,
    errors: totalResult.errors.length,
  });

  return totalResult;
}

// ============================================================================
// Claude Code Sync
// ============================================================================

/**
 * Sync Claude Code sessions
 *
 * Uses discoverClaudeSources() and parseClaudeSession() from the parser module.
 * Handles parser errors gracefully — errors are captured in SyncResult.errors.
 */
async function syncClaudeCodeSource(opts: SyncSourceOptions): Promise<SyncResult> {
  const { discoverClaudeSources } = await import('./sources');

  const { getConfig } = await import('../config');
  const toolDirs = getConfig().toolDirs;
  const sources = await discoverClaudeSources(toolDirs.get('claude-code'));
  const totalResult = createSyncResult();

  try {
    const candidates = await collectSessionFileCandidates(sources, 'claude-code', opts);

    for (const candidate of candidates) {
      try {
        await parseAndWriteCandidate('claude-code', candidate, opts, totalResult);
      } catch (err) {
        totalResult.errors.push(
          `Failed to parse Claude session ${candidate.filePath}: ${err}`
        );
      }
    }
  } catch (err) {
    totalResult.errors.push(`Failed to collect Claude session files: ${err}`);
  }

  sseManager.emit('sync_complete', {
    source: 'claude-code',
    sessionsInserted: totalResult.sessionsInserted,
    sessionsUpdated: totalResult.sessionsUpdated,
    errors: totalResult.errors.length,
  });

  return totalResult;
}

// ============================================================================
// Codex Sync
// ============================================================================

/**
 * Sync Codex sessions
 *
 * Uses discoverCodexSources() and parseCodexSession() from the parser module.
 * Handles parser errors gracefully — errors are captured in SyncResult.errors.
 */
async function syncCodexSource(opts: SyncSourceOptions): Promise<SyncResult> {
  const { discoverCodexSources } = await import('./sources');

  const { getConfig } = await import('../config');
  const toolDirs = getConfig().toolDirs;
  const sources = await discoverCodexSources(toolDirs.get('codex'));
  // Regular full sync is a directory consistency check plus per-file
  // skip/incremental parsing. Do not pre-scan every Codex JSONL file for
  // relationships here; relationships are collected from files parsed in this
  // run and `collectCodexRelationships()` remains available for explicit
  // maintenance/backfill callers.
  const relationshipsByChild: CodexRelationshipsByChild = new Map();
  const totalResult = createSyncResult();

  try {
    const candidates = await collectSessionFileCandidates(sources, 'codex', opts);

    for (const candidate of candidates) {
      try {
        await parseAndWriteCandidate('codex', candidate, opts, totalResult, relationshipsByChild);
      } catch (err) {
        totalResult.errors.push(
          `Failed to parse Codex session ${candidate.filePath}: ${err}`
        );
      }
    }
  } catch (err) {
    totalResult.errors.push(`Failed to collect Codex session files: ${err}`);
  }

  try {
    collectCodexRelationshipsFromStoredLinks(getDatabase(), relationshipsByChild);
    if (relationshipsByChild.size > 0) {
      backfillCodexRelationships(getDatabase(), relationshipsByChild);
    }
  } catch (err) {
    totalResult.errors.push(`Codex relationship backfill failed: ${err}`);
  }

  sseManager.emit('sync_complete', {
    source: 'codex',
    sessionsInserted: totalResult.sessionsInserted,
    sessionsUpdated: totalResult.sessionsUpdated,
    errors: totalResult.errors.length,
  });

  return totalResult;
}

// ============================================================================
// Qoder Sync
// ============================================================================

/**
 * Sync Qoder sessions
 *
 * Unlike other sources that iterate JSONL files, Qoder iterates session rows
 * from a readonly SQLite database. Uses per-session fingerprint skip cache
 * (D-03) stored in sessions.file_hash.
 */
async function syncQoderSource(opts: SyncSourceOptions): Promise<SyncResult> {
  const { discoverQoderSources } = await import('./sources');
  const { parseQoderSession, computeQoderSessionFingerprint } = await import('../parser/qoder');

  const { getConfig } = await import('../config');
  const toolDirs = getConfig().toolDirs;
  const sources = await discoverQoderSources(toolDirs.get('qoder'));
  const totalResult = createSyncResult();

  for (const source of sources) {
    // Skip non-configured sources (absent/invalid DB)
    if (source.error) continue;

    let db: Database.Database | null = null;
    try {
      db = new Database(source.path, { readonly: true, fileMustExist: true });

      // Enumerate sessions with fingerprint metadata
      const sessionRows = withSyncRetry(() =>
        db!.prepare(
          `SELECT session_id, gmt_modified,
                  (SELECT COUNT(*) FROM chat_message m WHERE m.session_id = chat_session.session_id) AS msg_count,
                  (SELECT MAX(gmt_create) FROM chat_message m WHERE m.session_id = chat_session.session_id) AS max_msg_gmt
           FROM chat_session ORDER BY gmt_modified DESC`
        ).all()
      ) as Array<{ session_id: string; gmt_modified: number; msg_count: number; max_msg_gmt: number | null }>;

      const database = getDatabase();

      for (const row of sessionRows) {
        try {
          const rawSessionId = row.session_id;
          // Compute per-session fingerprint (D-03)
          const fingerprint = computeQoderSessionFingerprint({
            id: rawSessionId,
            gmt_modified: row.gmt_modified,
            msg_count: row.msg_count,
            max_msg_gmt: row.max_msg_gmt,
          });
          const cacheKey = buildParserCacheHash('qoder', fingerprint);

          // Check skip cache — compare with existing file_hash (D-03)
          const canonicalId = `qoder:${rawSessionId}`;
          const existing = database.prepare(
            'SELECT file_hash FROM sessions WHERE id = ?'
          ).get(canonicalId) as { file_hash: string | null } | undefined;

          if (existing?.file_hash === cacheKey && !opts.force) {
            // Session unchanged — skip
            continue;
          }

          // Parse the session
          const parseResult = await parseQoderSession(source.path, rawSessionId, { force: opts.force });

          // Write through canonical pipeline with a logical per-session file path.
          // The cache key is the Qoder session fingerprint, not a whole-DB hash.
          const filePath = `${source.path}#${rawSessionId}`;
          const writeResult = writeSessionToDatabase(parseResult, undefined, filePath, {
            force: opts.force,
            cacheFileHash: cacheKey,
            sourceFileStatsPath: source.path,
          });

          if (writeResult.errors.length === 0) {
            // Defensive backstop for existing rows written before cacheFileHash support.
            database.prepare(
              'UPDATE sessions SET file_hash = ? WHERE id = ?'
            ).run(cacheKey, canonicalId);
          }

          mergeSyncResult(totalResult, writeResult);

          // Track warnings from parser
          for (const w of parseResult.warnings) {
            totalResult.errors.push(`Qoder parser warning [${rawSessionId}]: ${w}`);
          }
        } catch (err) {
          totalResult.errors.push(`Failed to parse Qoder session ${row.session_id}: ${err}`);
        }
      }
    } catch (err) {
      totalResult.errors.push(`Failed to sync Qoder source ${source.path}: ${err}`);
    } finally {
      db?.close();
    }
  }

  sseManager.emit('sync_complete', {
    source: 'qoder',
    sessionsInserted: totalResult.sessionsInserted,
    sessionsUpdated: totalResult.sessionsUpdated,
    errors: totalResult.errors.length,
  });

  return totalResult;
}

/**
 * Retry helper for Qoder sync SQLITE_BUSY errors.
 */
function withSyncRetry<T>(fn: () => T, retries = 3, delayMs = 100): T {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isBusy = msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
      if (!isBusy || attempt === retries) throw err;
      // Wait before retry
      const end = Date.now() + delayMs;
      while (Date.now() < end) { /* busy-wait */ }
    }
  }
  throw new Error('withSyncRetry exhausted');
}

/**
 * Backfill Codex subagent relationship columns for already-indexed child sessions.
 *
 * Iterates over a map of child IDs → parent/root IDs and updates matching
 * Codex session rows that still have root/null relationship_type. The function
 * is idempotent: running it twice on the same data produces identical rows.
 *
 * @param database - better-sqlite3 database instance
 * @param relationships - Map from child session ID to { parentSessionId, rootSessionId? }
 * @returns Number of rows updated
 */
export function backfillCodexRelationships(
  database: Database.Database,
  relationships: CodexRelationshipsByChild
): number {
  let totalUpdated = 0;

  const backfill = database.transaction(() => {
    const stmt = database.prepare(`
      UPDATE sessions
      SET parent_session_id = ?,
          root_session_id = ?,
          relationship_type = 'subagent',
          source_session_id = COALESCE(source_session_id, id)
      WHERE source = 'codex'
        AND id = ?
    `);

    for (const [childId, rel] of relationships) {
      if (!childId || childId === rel.parentSessionId || !rel.parentSessionId) {
        continue;
      }
      const result = stmt.run(rel.parentSessionId, rel.rootSessionId || rel.parentSessionId, childId);
      totalUpdated += result.changes;
    }
  });

  backfill();
  return totalUpdated;
}

// ============================================================================
// OpenCode Sync
// ============================================================================

async function syncOpencodeSource(opts: SyncSourceOptions): Promise<SyncResult> {
  const { discoverOpencodeSources } = await import('./sources');
  const { parseOpencodeSession, computeOpencodeSkipKey } = await import('../parser/opencode');

  const { getConfig } = await import('../config');
  const toolDirs = getConfig().toolDirs;
  const sources = await discoverOpencodeSources(toolDirs.get('opencode'));

  const totalResult = createSyncResult();
  const database = getDatabase();

  if (sources.length === 0 || sources[0].error) {
    totalResult.errors.push(
      sources[0]?.error ?? 'No OpenCode database found'
    );
    return totalResult;
  }

  const dbPath = sources[0].path;
  let ocDb: Database.Database;

  try {
    ocDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    totalResult.errors.push(
      `Failed to open OpenCode DB at ${dbPath}: ${err instanceof Error ? err.message : err}`
    );
    return totalResult;
  }

  try {
    const sessionRows = ocDb.prepare(
      'SELECT s.*, p.worktree as project_worktree FROM session s LEFT JOIN project p ON s.project_id = p.id ORDER BY s.time_updated DESC'
    ).all() as (Record<string, unknown> & { project_worktree?: string | null })[];

    if (totalResult.metrics) {
      totalResult.metrics.filesConsidered = sessionRows.length;
    }

    for (const row of sessionRows) {
      try {
        const rawSessionId = row.id as string;
        const sessionRow = row as unknown as import('../parser/opencode').OpencodeSessionRow;

        const msgCountRow = ocDb.prepare(
          'SELECT COUNT(*) as cnt FROM message WHERE session_id = ?'
        ).get(rawSessionId) as { cnt: number };

        const partCountRow = ocDb.prepare(
          'SELECT COUNT(*) as cnt FROM part WHERE session_id = ?'
        ).get(rawSessionId) as { cnt: number };

        const skipKey = computeOpencodeSkipKey(
          sessionRow,
          msgCountRow.cnt,
          partCountRow.cnt,
        );

        const canonicalId = `opencode:${rawSessionId}`;

        if (!opts.force) {
          const existing = database.prepare(
            'SELECT file_hash FROM sessions WHERE id = ?'
          ).get(canonicalId) as { file_hash: string | null } | undefined;

          if (existing?.file_hash === skipKey) {
            if (totalResult.metrics) {
              totalResult.metrics.filesSkippedBeforeParse++;
            }
            continue;
          }
        }

        const projectOverride = (row.project_worktree as string) || (row.directory as string) || undefined;
        const parseResult = await parseOpencodeSession(dbPath, rawSessionId, projectOverride);

        recordFileParsed(totalResult, 'full');
        parseResult.session.name = parseResult.session.name || extractSessionName(parseResult);
        parseResult.session.project = extractProjectFromParsedSession(parseResult, projectOverride ?? 'default');

        const writeResult = writeSessionToDatabase(
          parseResult,
          database,
          undefined,
          { force: opts.force ?? false },
        );

        const lastSyncAt = new Date().toISOString();
        database.prepare(`
          UPDATE sessions SET
            file_path = ?,
            file_hash = ?,
            last_sync_at = ?
          WHERE id = ? AND source = 'opencode'
        `).run(`${dbPath}#${rawSessionId}`, skipKey, lastSyncAt, canonicalId);

        mergeSyncResult(totalResult, writeResult);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('SQLITE_BUSY')) {
          logger.warn(`[sync:opencode] Skipping session ${row.id}: DB busy`);
          totalResult.errors.push(`Skipped session ${row.id}: DB busy`);
        } else {
          totalResult.errors.push(`Failed to sync opencode session ${row.id}: ${msg}`);
        }
      }
    }
  } catch (err) {
    totalResult.errors.push(
      `Failed to query OpenCode sessions: ${err instanceof Error ? err.message : err}`
    );
  } finally {
    ocDb.close();
  }

  sseManager.emit('sync_complete', {
    source: 'opencode',
    sessionsInserted: totalResult.sessionsInserted,
    sessionsUpdated: totalResult.sessionsUpdated,
    errors: totalResult.errors.length,
  });

  return totalResult;
}

export async function collectCodexRelationships(
  sources: Array<{ path: string; error?: string; sessionCount: number }>
): Promise<CodexRelationshipsByChild> {
  const relationships: CodexRelationshipsByChild = new Map();
  const fsp = await import('fs/promises');
  const readline = await import('readline');

  for (const source of sources) {
    if (source.error || source.sessionCount === 0) continue;

    let files: string[];
    try {
      files = await fsp.readdir(source.path);
    } catch {
      continue;
    }

    for (const file of files.filter((f) => f.endsWith('.jsonl'))) {
      const filePath = `${source.path}/${file}`;
      if (!fs.existsSync(filePath)) continue;
      const stream = fs.createReadStream(filePath);
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const payload = parsed?.event_msg || parsed?.payload;
            if (
              parsed?.type === 'event_msg' &&
              payload?.type === 'collab_agent_spawn_end' &&
              typeof payload.new_thread_id === 'string' &&
              typeof payload.sender_thread_id === 'string'
            ) {
              relationships.set(payload.new_thread_id, {
                parentSessionId: payload.sender_thread_id,
                rootSessionId: payload.sender_thread_id,
              });
            }
          } catch {
            // Relationship collection is best-effort; parser records malformed lines later.
          }
        }
      } finally {
        rl.close();
      }
    }
  }

  return relationships;
}
