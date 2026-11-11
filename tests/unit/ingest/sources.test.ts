import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock os.homedir for predictable test behavior
vi.mock('os', () => ({
  default: {
    homedir: () => '/mock/home/user',
  },
  homedir: () => '/mock/home/user',
}));

// Mock fs/promises for deterministic file system tests
const mockAccess = vi.fn();
const mockReaddir = vi.fn();
const dirent = (name: string, kind: 'file' | 'dir') => ({
  name,
  isFile: () => kind === 'file',
  isDirectory: () => kind === 'dir',
});

vi.mock('fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => mockAccess(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
  },
  access: (...args: unknown[]) => mockAccess(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
}));

// Mock ingest/config to return predictable toolDirs
vi.mock('@/ingest/config', () => ({
  getConfig: () => ({
    toolDirs: new Map([
      ['openclaw', ['/mock/home/user/.openclaw/agents']],
      ['claude-code', ['/mock/home/user/.claude/projects']],
      ['codex', ['/mock/home/user/.codex/sessions']],
    ]),
  }),
}));

import {
  discoverClaudeSources,
  discoverCodexSources,
  getSourceConfig,
  type SourceConfig,
  type DiscoveredSource,
} from '@/ingest/sync/sources';

describe('Claude Code Source Discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('discoverClaudeSources', () => {
    it('should return DiscoveredSource[] with type claude-code', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['session1.jsonl', 'session2.jsonl', 'other.txt']);

      const sources = await discoverClaudeSources();

      expect(Array.isArray(sources)).toBe(true);
      expect(sources.length).toBeGreaterThan(0);
      expect(sources[0].type).toBe('claude-code');
    });

    it('should use dirs from config when no dirs param', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['session1.jsonl']);

      await discoverClaudeSources();

      expect(mockAccess).toHaveBeenCalled();
      const accessedPath = mockAccess.mock.calls[0][0];
      expect(accessedPath).toContain('.claude');
      expect(accessedPath).toContain('projects');
    });

    it('should use dirs param override when provided', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['session1.jsonl']);

      await discoverClaudeSources(['/custom/claude/sessions']);

      expect(mockAccess.mock.calls[0][0]).toBe('/custom/claude/sessions');
    });

    it('should filter to only .jsonl files', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        'session1.jsonl',
        'session2.jsonl',
        'readme.md',
        '.DS_Store',
        'config.json',
      ]);

      const sources = await discoverClaudeSources();

      expect(sources[0].sessionCount).toBe(2);
    });

    it('should handle missing directory gracefully', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const sources = await discoverClaudeSources();

      expect(sources.length).toBe(1);
      expect(sources[0].type).toBe('claude-code');
      expect(sources[0].error).toBeDefined();
      expect(sources[0].sessionCount).toBe(0);
    });

    it('should handle read errors gracefully', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

      const sources = await discoverClaudeSources();

      expect(sources.length).toBe(1);
      expect(sources[0].error).toBeDefined();
      expect(sources[0].sessionCount).toBe(0);
    });

    it('should report sessionCount matching number of .jsonl files', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([
        's1.jsonl', 's2.jsonl', 's3.jsonl',
        's4.jsonl', 's5.jsonl',
      ]);

      const sources = await discoverClaudeSources();

      expect(sources[0].sessionCount).toBe(5);
    });

    it('should discover nested project and subagent session directories', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockImplementation(async (path: string) => {
        if (path === '/mock/home/user/.claude/projects') {
          return [dirent('project-a', 'dir')];
        }
        if (path === '/mock/home/user/.claude/projects/project-a') {
          return [
            dirent('main.jsonl', 'file'),
            dirent('notes.txt', 'file'),
            dirent('subagents', 'dir'),
          ];
        }
        if (path === '/mock/home/user/.claude/projects/project-a/subagents') {
          return [dirent('agent-1.jsonl', 'file'), dirent('agent-2.jsonl', 'file')];
        }
        return [];
      });

      const sources = await discoverClaudeSources();

      expect(sources).toEqual([
        {
          type: 'claude-code',
          path: '/mock/home/user/.claude/projects/project-a',
          sessionCount: 1,
        },
        {
          type: 'claude-code',
          path: '/mock/home/user/.claude/projects/project-a/subagents',
          sessionCount: 2,
        },
      ]);
    });
  });
});

describe('Codex Source Discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('discoverCodexSources', () => {
    it('should return DiscoveredSource[] with type codex', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['codex-session.jsonl']);

      const sources = await discoverCodexSources();

      expect(Array.isArray(sources)).toBe(true);
      expect(sources.length).toBeGreaterThan(0);
      expect(sources[0].type).toBe('codex');
    });

    it('should use default path ~/.codex/sessions/', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['session1.jsonl']);

      await discoverCodexSources();

      expect(mockAccess).toHaveBeenCalled();
      const accessedPath = mockAccess.mock.calls[0][0];
      expect(accessedPath).toContain('.codex');
      expect(accessedPath).toContain('sessions');
    });

    it('should use dirs param override when provided', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['session1.jsonl']);

      await discoverCodexSources(['/custom/codex/sessions']);

      expect(mockAccess.mock.calls[0][0]).toBe('/custom/codex/sessions');
    });

    it('should handle missing directory gracefully', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      const sources = await discoverCodexSources();

      expect(sources.length).toBe(1);
      expect(sources[0].type).toBe('codex');
      expect(sources[0].error).toBeDefined();
      expect(sources[0].sessionCount).toBe(0);
    });

    it('should handle read errors gracefully', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockRejectedValue(new Error('EACCES: permission denied'));

      const sources = await discoverCodexSources();

      expect(sources[0].error).toBeDefined();
      expect(sources[0].sessionCount).toBe(0);
    });

    it('should discover recursively nested year/month/day session directories', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockImplementation(async (path: string) => {
        if (path === '/mock/home/user/.codex/sessions') {
          return [dirent('2026', 'dir')];
        }
        if (path === '/mock/home/user/.codex/sessions/2026') {
          return [dirent('05', 'dir')];
        }
        if (path === '/mock/home/user/.codex/sessions/2026/05') {
          return [dirent('07', 'dir')];
        }
        if (path === '/mock/home/user/.codex/sessions/2026/05/07') {
          return [dirent('rollout-a.jsonl', 'file'), dirent('rollout-b.jsonl', 'file')];
        }
        return [];
      });

      const sources = await discoverCodexSources();

      expect(sources).toEqual([
        {
          type: 'codex',
          path: '/mock/home/user/.codex/sessions/2026/05/07',
          sessionCount: 2,
        },
      ]);
    });
  });
});

describe('getSourceConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return non-empty arrays for claude-code', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue(['s1.jsonl']);

    const configs = await getSourceConfig('claude-code');

    expect(Array.isArray(configs)).toBe(true);
    expect(configs.length).toBeGreaterThan(0);
    expect(configs[0].type).toBe('claude-code');
    expect(configs[0]).toHaveProperty('path');
    expect(configs[0]).toHaveProperty('enabled');
  });

  it('should return non-empty arrays for codex', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue(['s1.jsonl']);

    const configs = await getSourceConfig('codex');

    expect(Array.isArray(configs)).toBe(true);
    expect(configs.length).toBeGreaterThan(0);
    expect(configs[0].type).toBe('codex');
  });

  it('should return enabled:true for valid sources', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue(['s1.jsonl']);

    const configs = await getSourceConfig('claude-code');

    expect(configs[0].enabled).toBe(true);
  });

  it('should return enabled:false for sources with errors', async () => {
    mockAccess.mockRejectedValue(new Error('Not found'));

    const configs = await getSourceConfig('codex');

    expect(configs[0].enabled).toBe(false);
  });
});
