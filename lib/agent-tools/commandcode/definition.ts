/**
 * Command Code Agent Tool Definition
 *
 * Session browsing + replay focused. Same capability set as Claude Code —
 * Includes recorded usage and tool history; no live Gateway integration.
 */

import type { AgentToolDefinition } from '../types'

const definition: AgentToolDefinition = {
  id: 'commandcode',
  label: 'Command Code',
  shortLabel: 'COMMAND CODE',
  defaultRoute: '/dashboard',
  capabilities: {
    sessions: true,
    replay: true,
    activity: true,
    office: false,
    workspace: false,
    subagents: false,
    cost: true,
    approvals: false,
  },
  nav: [
    {
      id: 'ovr',
      href: (toolId) => `/${toolId}/dashboard`,
      label: 'OVR',
      title: 'Overview',
    },
    {
      id: 'ses',
      href: (toolId) => `/${toolId}/sessions`,
      label: 'SES',
      title: 'Sessions',
    },
  ],
  ui: {
    brand: {
      name: 'Command Code',
      versionLabel: 'COMMAND CODE',
      color: 'oklch(0.78 0.10 250)',
    },
    sessionColumns: [
      { id: 'label', header: 'SESSION', accessor: 'label', sortable: true },
      { id: 'status', header: 'STATUS', accessor: 'status' },
      { id: 'model', header: 'MODEL', accessor: 'model', sortable: true },
      { id: 'project', header: 'PROJECT', accessor: 'project' },
      { id: 'updatedAt', header: 'UPDATED', accessor: 'updatedAt', sortable: true },
    ],
  },
}

export default definition
