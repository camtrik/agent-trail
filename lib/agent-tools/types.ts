/**
 * Agent Tool Type System
 *
 * Defines the compile-time contract for the multi-source agent dashboard.
 * All types are pure TypeScript — no React dependencies, no IO.
 *
 * @see .planning/research/ARCHITECTURE.md for architectural context
 */

// ============================================================================
// Agent Tool Identity
// ============================================================================

/**
 * Concrete ingest-backed agent tool sources.
 * Must remain compatible with TraceSource in types/trace.ts.
 */
export type SourceToolId = 'openclaw' | 'claude-code' | 'codex' | 'commandcode' | 'opencode' | 'qoder'

/**
 * Supported tool scopes in the shell.
 * `all` is a synthetic aggregate scope, not an ingest source.
 */
export type AgentToolId = 'all' | SourceToolId

// ============================================================================
// Session Column Definitions
// ============================================================================

/**
 * Column definition for the Session Explorer table.
 * Per-tool profiles define which columns their session table shows.
 */
export interface SessionColumnDef {
  /** Unique column identifier */
  id: string
  /** Uppercase HUD label displayed in column header */
  header: string
  /** Key in the data row object */
  accessor: string
  /** Whether the column supports sort toggling */
  sortable?: boolean
  /** CSS grid column width (e.g. '1fr', '120px') */
  width?: string
}

// ============================================================================
// Tool Capabilities
// ============================================================================

/**
 * Feature flags declaring what capabilities a tool supports.
 * Used by CapabilityGate to conditionally render nav items, pages, and features.
 *
 * Default values (before tool-specific overrides):
 * - sessions: true
 * - replay: true
 * - activity: true
 * - All others: false
 */
export interface AgentToolCapabilities {
  /** Session browsing (list + detail) */
  sessions: boolean
  /** Turn-level session replay */
  replay: boolean
  /** Activity/event log browsing */
  activity: boolean
  /** Office/workspace overview page */
  office: boolean
  /** Active workspace view */
  workspace: boolean
  /** Subagent relationship tracking */
  subagents: boolean
  /** Cost/usage tracking */
  cost: boolean
  /** Approval workflow visibility */
  approvals: boolean
}

// ============================================================================
// Navigation
// ============================================================================

/**
 * Navigation item for the sidebar.
 * Each tool profile defines its own nav items filtered by capabilities.
 */
export interface ToolNavItem {
  /** Unique nav item identifier (e.g. 'ovr', 'ses', 'act') */
  id: string
  /** URL builder function that accepts a tool ID and returns the full href */
  href: (toolId: AgentToolId) => string
  /** Short abbreviation label (e.g. 'OVR', 'SES', 'ACT') */
  label: string
  /** Full tooltip title (e.g. 'Overview', 'Sessions', 'Activity') */
  title: string
  /** If set, nav item only appears when this capability is true */
  requiredCapability?: keyof AgentToolCapabilities
}

// ============================================================================
// UI Profile
// ============================================================================

/**
 * Per-tool UI profile defining brand, columns, slots, and formatters.
 * All fields are client-safe — no server-only functions or IO.
 */
export interface AgentToolUIProfile {
  /** Brand identity for header and status bar */
  brand: {
    /** Display name (e.g. 'OpenClaw', 'Claude Code', 'Codex') */
    name: string
    /** Optional version label (e.g. 'GATEWAY · v3.2.1') */
    versionLabel?: string
    /** Optional accent color token for theme customization */
    accentToken?: string
    /** Source identity color used for badges, labels, and chart accents (oklch string) */
    color?: string
  }
  /** Column definitions for the Session Explorer table */
  sessionColumns: SessionColumnDef[]
  /** Optional dashboard slot components (filled in later phases) */
  dashboardSlots?: {
    overviewHero?: React.ComponentType
    rightRail?: React.ComponentType
    emptyState?: React.ComponentType
  }
  /** Optional replay block registry for tool-specific rendering */
  replayBlocks?: ReplayBlockRegistry
  /** Optional session label formatter */
  formatSessionLabel?: (session: NormalizedSession) => string
  /** Optional tool name formatter for display */
  formatToolName?: (tool: NormalizedToolCall) => string
}

// ============================================================================
// Forward-declared types (stubs for later phases)
// ============================================================================

/**
 * Placeholder for NormalizedSession type (defined in Phase 5).
 * Used by formatSessionLabel in AgentToolUIProfile.
 */
export interface NormalizedSession {
  id: string
  toolId: AgentToolId
  title: string
  status: 'active' | 'idle' | 'aborted' | 'error' | 'complete'
  createdAt?: string
  updatedAt?: string
  model?: string
  totalTokens?: number
  costUsd?: number
  kind?: string
  parentSessionId?: string
  tags?: string[]
}

/**
 * Placeholder for NormalizedToolCall type (defined in Phase 5).
 * Used by formatToolName in AgentToolUIProfile.
 */
export interface NormalizedToolCall {
  id: string
  name: string
  category: 'Read' | 'Write' | 'Edit' | 'Bash' | 'Search' | 'Task' | 'Approval' | 'Network' | 'Other'
  inputJson?: string
  resultContent?: string
  subagentSessionId?: string
  startedAt?: string
  durationMs?: number
  status?: 'pending' | 'running' | 'success' | 'error' | 'canceled'
}

/**
 * Placeholder for ReplayBlockRegistry type (defined in Phase 5).
 * Maps tool names to display metadata for replay components.
 */
export interface ReplayBlockRegistry {
  /** Tool aliases for grouping/filtering in replay view */
  [toolName: string]: {
    displayName?: string
    icon?: string
    category?: string
    /** Whether to collapse this tool by default */
    collapseDefault?: boolean
  }
}

// ============================================================================
// Agent Tool Context
// ============================================================================

/**
 * Value provided by AgentToolProvider React context.
 * Available to all components within a [tool] layout.
 */
export interface AgentToolContextValue {
  /** Current tool ID from URL segment */
  toolId: AgentToolId
  /** Full tool definition with capabilities, nav, and UI profile */
  definition: AgentToolDefinition
  /** Tool capabilities for conditional rendering */
  capabilities: AgentToolCapabilities
  /** URL builder: prepends '/{toolId}' to the given route */
  href: (route: string) => string
}

// ============================================================================
// Agent Tool Definition
// ============================================================================

/**
 * Complete definition of an agent tool.
 * Each supported tool (openclaw, claude-code, codex, qoder) has one definition
 * registered in lib/agent-tools/registry.ts.
 */
export interface AgentToolDefinition {
  /** Tool identifier matching URL segment */
  id: AgentToolId
  /** Full display name (e.g. 'OpenClaw', 'Claude Code') */
  label: string
  /** Abbreviated label for tight spaces (e.g. 'OPENCLAW', 'CLAUDE:CODE') */
  shortLabel: string
  /** Default route when navigating to this tool (e.g. '/dashboard') */
  defaultRoute: string
  /** Feature flags controlling visible pages and capabilities */
  capabilities: AgentToolCapabilities
  /** Sidebar navigation items */
  nav: ToolNavItem[]
  /** UI profile with brand, columns, slots, and formatters */
  ui: AgentToolUIProfile
}
