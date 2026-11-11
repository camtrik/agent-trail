/**
 * Source Capability Configuration
 *
 * Static map declaring which overview modules are available per source.
 * Frontend uses this to show/hide agent modules, automation panels, and cost columns.
 *
 * Per D-XX: cost is null when source lacks price data.
 */

export interface SourceCapabilities {
  agents: boolean;
  automations: boolean;
  cost: boolean;
  activity: boolean;
  sessions: boolean;
  replay: boolean;
}

export const SOURCE_CAPABILITIES: Record<string, SourceCapabilities> = {
  openclaw: {
    agents: true,
    automations: true,
    cost: true,
    activity: true,
    sessions: true,
    replay: true,
  },
  'claude-code': {
    agents: false,
    automations: false,
    cost: true,
    activity: true,
    sessions: true,
    replay: true,
  },
  commandcode: {
    agents: false,
    automations: false,
    cost: true,
    activity: true,
    sessions: true,
    replay: true,
  },
  codex: {
    agents: false,
    automations: true,
    cost: false,
    activity: true,
    sessions: true,
    replay: true,
  },
  opencode: {
    agents: false,
    automations: false,
    cost: true,
    activity: true,
    sessions: true,
    replay: true,
  },
  qoder: {
    // Qoder cost is estimated from root-session token usage plus recursive
    // subagents, calibrated against Qoder Credits usage.
    agents: false,
    automations: false,
    cost: true,
    activity: true,
    sessions: true,
    replay: true,
  },
};
