/**
 * Canonical Trace Contract
 *
 * This module defines the canonical trace data model for agent-tracing-dashboard.
 * It supports multi-source architecture (OpenClaw, Claude Code, Codex, Qoder).
 *
 * The trace model is used by:
 * - Ingest service for parsing and indexing
 * - Parsers for source-specific log conversion
 * - Frontend for session replay and visualization
 *
 * @see ../references/agentsview/internal/parser/types.go for behavioral reference
 */

// ============================================================================
// Source Types
// ============================================================================

/**
 * Supported agent sources
 */
export type TraceSource = 'openclaw' | 'claude-code' | 'codex' | 'commandcode' | 'opencode' | 'qoder';

/**
 * Canonical display labels for trace sources.
 * All user-facing source names should read from this single map.
 */
export const SOURCE_LABELS: Record<TraceSource, string> = {
  openclaw: 'OpenClaw',
  'claude-code': 'Claude',
  codex: 'Codex',
  commandcode: 'Command Code',
  opencode: 'OpenCode',
  qoder: 'Qoder',
};

export const ALL_SOURCES_LABEL = 'All Sources';

export function isTraceSource(value: string): value is TraceSource {
  return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, value);
}

export function getSourceLabel(source: TraceSource | 'all' | string): string {
  if (source === 'all') return ALL_SOURCES_LABEL;
  return isTraceSource(source) ? SOURCE_LABELS[source] : source;
}

export function getSourceTag(source: TraceSource | 'all' | string): string {
  return getSourceLabel(source).toUpperCase();
}

/**
 * Ingest service status (file-based discovery and parsing)
 */
export type IngestStatus =
  | 'installed'       // Source directory exists
  | 'configured'      // Source has valid config/env
  | 'empty'           // No sessions found
  | 'indexing'        // Active sync in progress
  | 'error'           // Sync/parse failed
  | 'parser-warning'; // Parsed with warnings

/**
 * Live gateway connection status.
 */
export type GatewayStatus =
  | 'connected'
  | 'disconnected'
  | 'connecting'
  | 'error';

/**
 * Source metadata
 */
export interface TraceSourceMetadata {
  type: TraceSource;
  path: string;
  ingestStatus: IngestStatus;
  lastSyncAt?: string;
  sessionCount: number;
}

/**
 * Agent summary aggregated from sessions
 */
export interface AgentInfo {
  name: string
  sessionCount: number
  lastActiveAt: string | null
  latestStatus: SessionStatus
  toolCallCount: number
  emoji?: string
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Session status
 */
export type SessionStatus =
  | 'active'
  | 'idle'
  | 'aborted'
  | 'error'
  | 'unknown';

/**
 * Session-level metrics
 */
export interface SessionMetrics {
  messageCount: number;
  userMessageCount: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  hasToolCalls: boolean;
  terminationStatus?: string;
  parserMalformedLines: number;
  isTruncated: boolean;
}

export interface ActivityCounts {
  toolCalls: number;
  skills: number;
  subagents: number;
  thinking: number;
  system: number;
}

/**
 * Canonical session model
 *
 * A session represents a single agent conversation from start to end.
 * It may contain subagent relationships (forks, spawned agents).
 */
export interface TraceSession {
  id: string;
  source: TraceSource;
  project: string;
  name?: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt?: string;
  lastSyncAt?: string;
  status: SessionStatus;
  rootSessionId?: string; // For forks/subagents
  parentSessionId?: string; // For subagent relationships
  relationshipType?: 'root' | 'subagent' | 'fork' | 'continuation';
  sourceSessionId?: string;
  cwd?: string;
  gitBranch?: string;
  sourceVersion?: string;
  agentName?: string;
  model?: string;
  summary?: string;
  metrics: SessionMetrics;
  turns: TraceTurn[];
  activityCounts?: ActivityCounts;

  // Phase 10 enrichment fields (computed at query time)
  displayTitle?: string;
  durationMs?: number | null;
  totalTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number | null;
  sourceCostUsd?: number | null;
  costSource?: string | null;
  costPricingStatus?: string | null;
}

export interface TraceSessionSearchHit {
  id: string;
  sessionId: string;
  source: TraceSource;
  sourceSessionId?: string;
  project: string;
  name?: string;
  displayTitle: string;
  updatedAt?: string;
  summary?: string;
  snippet: string;
  matchCount: number;
}

export interface TraceSessionSearchResult {
  query: string;
  results: TraceSessionSearchHit[];
  pagination: {
    limit: number;
    returned: number;
    hasMore: boolean;
  };
}

// ============================================================================
// Turn Types
// ============================================================================

/**
 * Turn: user input + assistant response + activities
 *
 * A turn represents one complete user-agent exchange cycle.
 */
export interface TraceTurn {
  id: string;
  sessionId: string;
  index: number;
  userMessage: TraceMessage | null;
  assistantMessages: TraceMessage[];
  activities: TraceActivity[];
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  tokenUsage?: TokenUsage;
  /** True if turn was truncated by a compact boundary (D-10) */
  isTruncated?: boolean;
  /** Phase 10 enrichment: per-turn computed metadata */
  enrichment?: TurnEnrichment;
}

/**
 * Per-turn enrichment computed at query time (Phase 10).
 * Contains activity counts, failure status, and warning flags
 * for the compact turn header and inspector.
 */
export interface TurnEnrichment {
  activityCounts: ActivityCounts;
  failureStatus: 'success' | 'error' | 'partial';
  truncated: boolean;
  warningStatus: boolean;
}

// ============================================================================
// Message Types
// ============================================================================

/**
 * Message role
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool_result';

/**
 * Message within a turn
 */
export interface TraceMessage {
  id: string;
  ordinal: number;
  role: MessageRole;
  content: string;
  timestamp?: string;
  model?: string;
  tokenUsage?: TokenUsage;
  turnId?: string;
  turnIndex?: number;
  isRealUserInput?: boolean;
  sourceMetadata: SourceMetadata;
}

// ============================================================================
// Activity Union Type
// ============================================================================

/**
 * Activity: tool call, skill use, subagent link, thinking, or system event
 *
 * Discriminated union: use `type` field to determine which specific interface.
 */
export type TraceActivity =
  | TraceToolCall
  | TraceSkillUse
  | TraceSubagentLink
  | TraceThinkingBlock
  | TraceSystemEvent;

// ============================================================================
// Tool Call Types
// ============================================================================

/**
 * Tool category for UI grouping/filtering
 */
export type ToolCategory =
  | 'Bash'
  | 'Edit'
  | 'Read'
  | 'Grep'
  | 'Task'
  | 'Agent'
  | 'Other';

/**
 * Tool call activity
 */
export interface TraceToolCall {
  type: 'tool_call';
  id: string;
  name: string;
  category: ToolCategory;
  inputJson: string;
  resultEvents: TraceToolResultEvent[];
  status: 'pending' | 'success' | 'error';
  error?: string;
  durationMs?: number;
  /** Ordinal of the message that owns this tool call — used by sync to write tool_calls.message_ordinal */
  messageOrdinal?: number;
  /** Source line number for diagnostics */
  sourceLine?: number;
  /** Human-readable tool label for UI display (Phase 10 enrichment) */
  displayName?: string;
}

/**
 * Tool result event (streaming output chunks)
 */
export interface TraceToolResultEvent {
  type: 'result_event';
  timestamp?: string;
  content: string;
  isPartial: boolean;
}

// ============================================================================
// Skill Use Types
// ============================================================================

/**
 * Skill use activity (OpenClaw-specific)
 */
export interface TraceSkillUse {
  type: 'skill_use';
  name: string;
  inputSummary: string;
  result?: string;
  status: 'success' | 'error';
  /** Human-readable skill label for UI display (Phase 10 enrichment) */
  displayName?: string;
  /** Duration of skill execution in milliseconds (Phase 10 enrichment) */
  durationMs?: number;
  /** Error message if skill execution failed (Phase 10 enrichment) */
  error?: string;
}

// ============================================================================
// Subagent Link Types
// ============================================================================

/**
 * Subagent relationship (spawned or attached agent session)
 */
export interface TraceSubagentLink {
  type: 'subagent_link';
  subagentSessionId: string;
  subagentSource: TraceSource;
  relationship: 'spawned' | 'attached';
  /** Ordinal of the message that spawned or attached the subagent, when known. */
  messageOrdinal?: number;
  /** Duration of subagent session in milliseconds (Phase 10 enrichment) */
  durationMs?: number;
}

// ============================================================================
// Thinking Block Types
// ============================================================================

/**
 * Thinking/reasoning block (Claude Code extended thinking)
 */
export interface TraceThinkingBlock {
  type: 'thinking';
  content: string;
  isRedacted: boolean;
}

// ============================================================================
// System Event Types
// ============================================================================

/**
 * System event (errors, warnings, status changes)
 */
export interface TraceSystemEvent {
  type: 'system';
  subtype: string;
  content: string;
}

// ============================================================================
// Token Usage Types
// ============================================================================

/**
 * Token usage normalized across sources
 */
export interface TokenUsage {
  /** Persisted source estimate for this message/turn, when supplied. */
  sourceCostUsd?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  usageSemantics?: 'additive' | 'overlap';
}

// ============================================================================
// Source Metadata Types
// ============================================================================

/**
 * Source provenance metadata for debugging
 */
export interface SourceMetadata {
  sourceType: TraceSource;
  sourceFile: string;
  sourceLine?: number;
  sourceVersion?: string;
  cwd?: string;
  gitBranch?: string;
}
