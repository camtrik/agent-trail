/** Apply only existing, same-source lineage references after all candidate writes. */
import type Database from 'better-sqlite3';

export type SessionLineageEdge = { parentId?: string; hasParent: boolean; kind: 'root' | 'subagent' | 'fork' };

export function backfillSourceRelationships(
  database: Database.Database,
  source: 'openclaw' | 'opencode',
  edges: Map<string, SessionLineageEdge>,
): void {
  const rows = database.prepare('SELECT id, parent_session_id, relationship_type FROM sessions WHERE source = ?')
    .all(source) as Array<{ id: string; parent_session_id: string | null; relationship_type: string | null }>;
  const existingIds = new Set(rows.map((row) => row.id));
  const relations = new Map(edges);
  // Legacy JSONL ancestors can already be indexed without a SQLite window.
  for (const row of rows) {
    if (!relations.has(row.id)) relations.set(row.id, {
      hasParent: row.relationship_type !== 'root' || !!row.parent_session_id,
      parentId: row.parent_session_id ?? undefined,
      kind: row.relationship_type === 'fork' ? 'fork' : row.relationship_type === 'root' ? 'root' : 'subagent',
    });
  }
  function rootFor(childId: string): string | undefined {
    const visited = new Set([childId]);
    let current = relations.get(childId)?.parentId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const edge = relations.get(current);
      if (!edge) return undefined;
      if (!edge.hasParent) return current;
      current = edge.parentId;
    }
    return undefined;
  }
  const update = database.prepare(`UPDATE sessions SET parent_session_id = ?, root_session_id = ?, relationship_type = ?
    WHERE id = ? AND source = ?`);
  database.transaction(() => {
    for (const [childId, edge] of edges) {
      if (!existingIds.has(childId)) continue;
      const parent = edge.parentId && edge.parentId !== childId && existingIds.has(edge.parentId) ? edge.parentId : null;
      const root = edge.hasParent ? rootFor(childId) : undefined;
      update.run(parent, root && existingIds.has(root) ? root : null, edge.kind, childId, source);
    }
  })();
}
