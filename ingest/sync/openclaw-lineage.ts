/** Resolve OpenClaw references after window imports, independent of candidate order/cache hits. */
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openClawDatabasePathForChange, readOpenClawSqliteLineage } from '../parser/openclaw-sqlite';

import { backfillSourceRelationships, type SessionLineageEdge } from './session-lineage';

function sourceDatabase(filePath: string): string | undefined {
  const marker = 'openclaw-agent.sqlite#';
  const end = filePath.lastIndexOf(marker);
  return openClawDatabasePathForChange(end >= 0 ? filePath.slice(0, end + marker.length - 1) : filePath);
}

export async function backfillOpenClawRelationships(
  database: Database.Database,
  changedPaths: string[],
): Promise<string[]> {
  const stored = database.prepare("SELECT id, file_path FROM sessions WHERE source = 'openclaw'")
    .all() as Array<{ id: string; file_path: string }>;
  const dbPaths = new Set([...changedPaths, ...stored.map((row) => row.file_path)]
    .map(sourceDatabase).filter((value): value is string => !!value && existsSync(value)).map((value) => path.resolve(value)));
  const errors: string[] = [];
  const snapshots: Array<{ scope: string; data: Awaited<ReturnType<typeof readOpenClawSqliteLineage>> }> = [];
  const idsByKey = new Map<string, string>();
  for (const dbPath of dbPaths) {
    try {
      const data = await readOpenClawSqliteLineage(dbPath);
      // Session keys are shared across agents in one agents root, not across independent installs.
      const scope = path.dirname(path.dirname(path.dirname(dbPath)));
      snapshots.push({ scope, data });
      for (const node of data.nodes) idsByKey.set(`${scope}\0${node.session_key}`, node.current_session_id);
    } catch (error) {
      errors.push(`OpenClaw lineage metadata ${dbPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const edges = new Map<string, SessionLineageEdge>();
  const parentEdge = (scope: string, key: string | null): SessionLineageEdge => ({
    hasParent: !!key, parentId: key ? idsByKey.get(`${scope}\0${key}`) : undefined,
    kind: key ? 'subagent' : 'root',
  });
  for (const { scope, data } of snapshots) {
    for (const node of data.nodes) edges.set(node.current_session_id, parentEdge(scope, node.parent_session_key));
  }
  for (const { scope, data } of snapshots) {
    for (const window of data.windows) {
      edges.set(window.id, window.parentKey ? parentEdge(scope, window.parentKey)
        : window.reason === 'fork' && window.previousId
          ? { hasParent: true, parentId: window.previousId, kind: 'fork' } : { hasParent: false, kind: 'root' });
    }
  }
  backfillSourceRelationships(database, 'openclaw', edges);
  return errors;
}
