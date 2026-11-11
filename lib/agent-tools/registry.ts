/**
 * Agent Tool Registry
 *
 * Central registry mapping AgentToolId to AgentToolDefinition.
 * Used by AgentToolProvider to resolve tool profiles at runtime.
 *
 * Pure TypeScript — no React, no IO, no side effects.
 */

import { getSourceLabel } from '@/types/trace'
import type { AgentToolDefinition, AgentToolId, SourceToolId } from './types'
import allDef from './all/definition'
import openclawDef from './openclaw/definition'
import claudeCodeDef from './claude-code/definition'
import codexDef from './codex/definition'
import commandcodeDef from './commandcode/definition'
import opencodeDef from './opencode/definition'
import qoderDef from './qoder/definition'

/**
 * Map of all tool definitions indexed by AgentToolId.
 * Used by getDefinition() for O(1) lookup.
 */
export const AGENT_TOOL_DEFINITIONS: Record<AgentToolId, AgentToolDefinition> = {
  'all': allDef,
  'openclaw': openclawDef,
  'claude-code': claudeCodeDef,
  'codex': codexDef,
  'commandcode': commandcodeDef,
  'opencode': opencodeDef,
  'qoder': qoderDef,
}

/**
 * Ordered array of source tool IDs.
 * Kept source-only for aggregate queries.
 */
export const TOOL_IDS: SourceToolId[] = ['openclaw', 'claude-code', 'codex', 'commandcode', 'opencode', 'qoder']

/**
 * Ordered array of all shell scopes, including synthetic aggregate views.
 */
export const SHELL_TOOL_IDS: AgentToolId[] = ['all', ...TOOL_IDS]

/**
 * Look up a tool definition by its ID.
 * Returns the full AgentToolDefinition — capabilities, nav, UI profile, etc.
 */
export function getDefinition(toolId: AgentToolId): AgentToolDefinition {
  return AGENT_TOOL_DEFINITIONS[toolId]
}

/**
 * Return all tool definitions as an array.
 * Order: openclaw, claude-code, codex, qoder.
 */
export function getAllDefinitions(): AgentToolDefinition[] {
  return [allDef, openclawDef, claudeCodeDef, codexDef, commandcodeDef, opencodeDef, qoderDef]
}

/**
 * Validate and narrow a raw string to AgentToolId.
 * Throws an Error with a descriptive message listing valid IDs if the input
 * does not match one of 'openclaw', 'claude-code', 'codex', or 'qoder'.
 *
 * Use this at trust boundaries (e.g. URL param parsing) to ensure
 * downstream code only sees valid AgentToolId values.
 */
export function assertAgentToolId(raw: string): AgentToolId {
  const validIds: AgentToolId[] = SHELL_TOOL_IDS
  if (validIds.includes(raw as AgentToolId)) {
    return raw as AgentToolId
  }
  throw new Error(
    `Invalid agent tool ID: "${raw}". Expected one of: ${validIds.join(', ')}.`,
  )
}

export function assertSourceToolId(raw: string): SourceToolId {
  if (TOOL_IDS.includes(raw as SourceToolId)) {
    return raw as SourceToolId
  }
  throw new Error(
    `Invalid source tool ID: "${raw}". Expected one of: ${TOOL_IDS.join(', ')}.`,
  )
}

/**
 * Returns the brand color for a given tool ID.
 * Falls back to 'var(--muted-foreground)' for tools without a defined color (e.g. 'all').
 */
export function getSourceColor(toolId: string): string {
  return AGENT_TOOL_DEFINITIONS[toolId as AgentToolId]?.ui.brand.color ?? 'var(--muted-foreground)'
}

/**
 * Returns the display name for a given tool ID.
 * Falls back to the raw toolId string for unknown tools.
 */
export function getSourceName(toolId: string): string {
  return getSourceLabel(toolId)
}
