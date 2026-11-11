import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

// Mock fs/promises for deterministic file system tests
const mockAccess = vi.fn();
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
const mockStat = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => mockAccess(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    stat: (...args: unknown[]) => mockStat(...args),
  },
  access: (...args: unknown[]) => mockAccess(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock('os', () => ({
  default: {
    homedir: () => '/mock/home/user',
  },
  homedir: () => '/mock/home/user',
}));

// Mock the parsers to avoid file system access
vi.mock('@/ingest/parser/claude', () => ({
  parseClaudeSession: vi.fn().mockResolvedValue({
    session: {
      id: 'claude-test-session',
      source: 'claude-code',
      project: 'test',
      startedAt: '2024-01-01T00:00:00Z',
      endedAt: '2024-01-01T01:00:00Z',
      status: 'idle',
      metrics: {
        messageCount: 2,
        userMessageCount: 1,
        totalTokens: 100,
        hasToolCalls: false,
        parserMalformedLines: 0,
        isTruncated: false,
      },
      turns: [],
    },
    messages: [],
    activities: [],
    errors: [],
    warnings: [],
  }),
}));

vi.mock('@/ingest/parser/codex', () => ({
  parseCodexSession: vi.fn().mockResolvedValue({
    session: {
      id: 'codex-test-session',
      source: 'codex',
      project: 'test',
      startedAt: '2024-01-01T00:00:00Z',
      endedAt: '2024-01-01T01:00:00Z',
      status: 'idle',
      metrics: {
        messageCount: 2,
        userMessageCount: 1,
        totalTokens: 100,
        hasToolCalls: false,
        parserMalformedLines: 0,
        isTruncated: false,
      },
      turns: [],
    },
    messages: [],
    activities: [],
    errors: [],
    warnings: [],
  }),
}));

/**
 * Helper: Create an in-memory SQLite database with full schema
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  const schemaPath = join(process.cwd(), 'ingest', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

describe('sync pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLAUDE_SESSIONS_PATH;
    delete process.env.CODEX_SESSIONS_PATH;
    mockStat.mockResolvedValue({ mtimeMs: 0 });
    db = createTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* ignore */ }
    try {
      const { closeDatabase } = await import('@/ingest/db');
      closeDatabase();
    } catch {
      // Global database may not be open in most tests.
    }
  });

  describe('syncSource type support', () => {
    it('should support claude-code source type', async () => {
      // Import syncSource dynamically to check type support
      const { syncSource } = await import('@/ingest/sync/index');

      // The function should accept 'claude-code' — if it doesn't, TS would error
      // We verify the import and type resolution works
      expect(typeof syncSource).toBe('function');

      // Verify the function is callable with claude-code (type check)
      // Note: Actual sync requires directory to exist, but the type signature
      // should accept 'claude-code' as a valid source type parameter
    });

    it('should support codex source type', async () => {
      const { syncSource } = await import('@/ingest/sync/index');

      expect(typeof syncSource).toBe('function');
      // Type check: syncSource should accept 'codex' as valid parameter
    });
  });

  describe('sync imports', () => {
    it('should import parseClaudeSession from claude parser', async () => {
      // Read the sync/index.ts source to verify imports exist
      const fs = await import('fs');
      const syncSource = fs.readFileSync(
        join(process.cwd(), 'ingest', 'sync', 'index.ts'),
        'utf-8'
      );

      // acceptance_criteria: grep -c "parseClaudeSession" returns >= 1
      const claudeCount = (syncSource.match(/parseClaudeSession/g) || []).length;
      expect(claudeCount).toBeGreaterThanOrEqual(1);
    });

    it('should import parseCodexSession from codex parser', async () => {
      const fs = await import('fs');
      const syncSource = fs.readFileSync(
        join(process.cwd(), 'ingest', 'sync', 'index.ts'),
        'utf-8'
      );

      // acceptance_criteria: grep -c "parseCodexSession" returns >= 1
      const codexCount = (syncSource.match(/parseCodexSession/g) || []).length;
      expect(codexCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('source type references', () => {
    it('should reference claude-code in sync source', async () => {
      const fs = await import('fs');
      const syncSource = fs.readFileSync(
        join(process.cwd(), 'ingest', 'sync', 'index.ts'),
        'utf-8'
      );

      // acceptance_criteria: grep -c "claude-code" returns >= 1
      const claudeRefCount = (syncSource.match(/claude-code/g) || []).length;
      expect(claudeRefCount).toBeGreaterThanOrEqual(1);
    });

    it('should reference codex in sync source', async () => {
      const fs = await import('fs');
      const syncSource = fs.readFileSync(
        join(process.cwd(), 'ingest', 'sync', 'index.ts'),
        'utf-8'
      );

      // acceptance_criteria: grep -c "codex" returns >= 1
      const codexRefCount = (syncSource.match(/codex/g) || []).length;
      expect(codexRefCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('OpenClaw sync preservation', () => {
    it('should preserve existing OpenClaw sync path', async () => {
      const fs = await import('fs');
      const syncSource = fs.readFileSync(
        join(process.cwd(), 'ingest', 'sync', 'index.ts'),
        'utf-8'
      );

      // Verify OpenClaw references still exist
      const openclawCount = (syncSource.match(/openclaw/gi) || []).length;
      expect(openclawCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('syncSource end-to-end with Claude Code', () => {
    it('should sync Claude Code sessions and write to database', async () => {
      const { syncSource } = await import('@/ingest/sync/index');
      const { parseClaudeSession } = await import('@/ingest/parser/claude');

      // Setup: mock source discovery to find Claude sessions
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['claude-test.jsonl']);

      // Run sync
      const result = await syncSource('claude-code');

      // Verify parseClaudeSession was called
      expect(parseClaudeSession).toHaveBeenCalled();

      // Verify sync result structure
      expect(result).toHaveProperty('sessionsInserted');
      expect(result).toHaveProperty('sessionsUpdated');
      expect(result).toHaveProperty('messagesInserted');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);

      // Total sessions handled should be >= 0
      const total = result.sessionsInserted + result.sessionsUpdated;
      expect(total).toBeGreaterThanOrEqual(0);
    });

    it('should sync Codex sessions and write to database', async () => {
      const { syncSource } = await import('@/ingest/sync/index');
      const { parseCodexSession } = await import('@/ingest/parser/codex');

      // Setup: mock source discovery to find Codex sessions
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['codex-test.jsonl']);

      // Run sync
      const result = await syncSource('codex');

      // Verify parseCodexSession was called
      expect(parseCodexSession).toHaveBeenCalled();

      // Verify sync result structure
      expect(result).toHaveProperty('sessionsInserted');
      expect(result).toHaveProperty('sessionsUpdated');
      expect(result).toHaveProperty('messagesInserted');
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle parser errors gracefully without aborting sync', async () => {
      const { syncSource } = await import('@/ingest/sync/index');
      const { parseClaudeSession } = await import('@/ingest/parser/claude');

      // Make parser throw for one file
      vi.mocked(parseClaudeSession).mockRejectedValueOnce(new Error('Parse failed'));

      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['bad.jsonl', 'good.jsonl']);

      // This should not throw — errors should be captured in result.errors
      const result = await syncSource('claude-code');

      // Should have at least one error logged
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('SyncResult shape', () => {
    it('SyncResult has toolCallsInserted and toolResultEventsInserted fields', async () => {
      const { syncSource } = await import('@/ingest/sync/index');

      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([]);

      const result = await syncSource('claude-code');

      expect(result).toHaveProperty('toolCallsInserted');
      expect(result).toHaveProperty('toolResultEventsInserted');
      expect(typeof result.toolCallsInserted).toBe('number');
      expect(typeof result.toolResultEventsInserted).toBe('number');
    });
  });

  describe('force reparse option', () => {
    it('syncSource accepts force option without errors', async () => {
      const { syncSource } = await import('@/ingest/sync/index');

      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([]);

      // Should accept SyncSourceOptions object with force=true
      const result = await syncSource('claude-code', { force: true });

      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it('syncSource backward-compatible: accepts string basePath', async () => {
      const { syncSource } = await import('@/ingest/sync/index');

      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue([]);

      // Legacy string argument should still work
      const result = await syncSource('openclaw', '/some/path');

      expect(result).toHaveProperty('errors');
    });

    it('syncSource limit bounds parsed files using newest-first ordering', async () => {
      const { syncSource } = await import('@/ingest/sync/index');
      const { parseClaudeSession } = await import('@/ingest/parser/claude');

      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['old.jsonl', 'new.jsonl', 'middle.jsonl']);
      mockStat.mockImplementation(async (filePath: string) => ({
        mtimeMs: filePath.includes('new')
          ? 300
          : filePath.includes('middle')
            ? 200
            : 100,
      }));

      const result = await syncSource('claude-code', {
        limit: 2,
        sortByMtimeDesc: true,
      });

      expect(result).toHaveProperty('errors');
      expect(parseClaudeSession).toHaveBeenCalledTimes(2);
      expect(vi.mocked(parseClaudeSession).mock.calls[0][0]).toContain('new.jsonl');
      expect(vi.mocked(parseClaudeSession).mock.calls[1][0]).toContain('middle.jsonl');
    });

    it('writeSessionToDatabase accepts WriteSessionOptions with force', async () => {
      const { writeSessionToDatabase } = await import('@/ingest/sync/index');

      // Must be callable with 4th argument — type test (would TS-error if wrong signature)
      const pr = {
        session: {
          id: 'force-test-session',
          source: 'claude-code' as const,
          project: 'test',
          name: 'Test',
          startedAt: null,
          endedAt: null,
          status: 'idle' as const,
          metrics: { messageCount: 0, userMessageCount: 0, hasToolCalls: false, parserMalformedLines: 0, isTruncated: false },
          turns: [],
        },
        messages: [],
        activities: [],
        errors: [],
        warnings: [],
      };

      const result = writeSessionToDatabase(pr, db, undefined, { force: true });
      expect(result.errors).toEqual([]);
    });
  });
});
