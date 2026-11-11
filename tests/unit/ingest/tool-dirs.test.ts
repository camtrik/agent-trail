// tests/unit/ingest/tool-dirs.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('os', () => ({
  default: { homedir: () => '/mock/home' },
  homedir: () => '/mock/home',
}));

// Mock fs to prevent real file reads
vi.mock('fs', () => ({
  default: { existsSync: () => false, readFileSync: () => '' },
  existsSync: () => false,
  readFileSync: () => '',
}));

import {
  TOOL_DIR_REGISTRY,
  resolveToolDirs,
} from '@/ingest/config/tool-dirs';

describe('TOOL_DIR_REGISTRY', () => {
  it('should contain entries for all six source types', () => {
    const types = TOOL_DIR_REGISTRY.map((d) => d.type);
    expect(types).toContain('openclaw');
    expect(types).toContain('claude-code');
    expect(types).toContain('codex');
    expect(types).toContain('opencode');
    expect(types).toContain('qoder');
    expect(types).toHaveLength(6);
  });

  it('should have envVar, configKey, and defaultDirs on every entry', () => {
    for (const def of TOOL_DIR_REGISTRY) {
      expect(def.envVar).toBeTruthy();
      expect(def.configKey).toBeTruthy();
      expect(def.defaultDirs.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveToolDirs', () => {
  beforeEach(() => {
    delete process.env.OPENCLAW_DIR;
    delete process.env.CLAUDE_PROJECTS_DIR;
    delete process.env.CODEX_SESSIONS_DIR;
    delete process.env.OPENCODE_DB_PATH;
    delete process.env.QODER_DB_PATH;
    delete process.env.AGENT_TRAIL_CONFIG;
    delete process.env.AGENTS_TRACING_CONFIG;
  });

  it('should return defaults when no env vars or config file', () => {
    const dirs = resolveToolDirs();
    expect(dirs.get('openclaw')).toEqual(['/mock/home/.openclaw/agents']);
    expect(dirs.get('claude-code')).toEqual(['/mock/home/.claude/projects']);
    expect(dirs.get('codex')).toEqual(['/mock/home/.codex/sessions']);
    expect(dirs.get('opencode')).toEqual(['/mock/home/.local/share/opencode']);
    expect(dirs.get('qoder')).toEqual(['/mock/home/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db']);
  });

  it('should use env var override when set', () => {
    process.env.OPENCLAW_DIR = '/custom/openclaw';
    const dirs = resolveToolDirs();
    expect(dirs.get('openclaw')).toEqual(['/custom/openclaw']);
    // Others still default
    expect(dirs.get('claude-code')).toEqual(['/mock/home/.claude/projects']);
  });

  it('should use config file values when no env var', () => {
    const dirs = resolveToolDirs({
      openclaw_dirs: ['/config/openclaw1', '/config/openclaw2'],
    });
    expect(dirs.get('openclaw')).toEqual(['/config/openclaw1', '/config/openclaw2']);
  });

  it('should prefer env var over config file', () => {
    process.env.CLAUDE_PROJECTS_DIR = '/env/claude';
    const dirs = resolveToolDirs({
      claude_project_dirs: ['/config/claude'],
    });
    expect(dirs.get('claude-code')).toEqual(['/env/claude']);
  });

  it('should resolve relative config paths against homedir', () => {
    const dirs = resolveToolDirs({
      openclaw_dirs: ['.openclaw-alt/agents'],
    });
    expect(dirs.get('openclaw')).toEqual(['/mock/home/.openclaw-alt/agents']);
  });

  it('should keep absolute config paths as-is', () => {
    const dirs = resolveToolDirs({
      codex_sessions_dirs: ['/absolute/codex/sessions'],
    });
    expect(dirs.get('codex')).toEqual(['/absolute/codex/sessions']);
  });
});
