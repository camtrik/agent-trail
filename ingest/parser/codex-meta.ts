import type { CodexJsonlLine, CodexPayload } from './types';

export function getCodexSessionMeta(parsed: CodexJsonlLine): {
  session_id?: string;
  parentSessionId?: string;
  cwd?: string;
  git_branch?: string;
  model?: string;
} | undefined {
  const payload: CodexPayload | undefined = parsed.session_meta || parsed.payload;
  if (!payload) return undefined;

  const rolloutId = nonEmptyString(payload.id);
  const legacyId = nonEmptyString(payload.session_id);
  const id = rolloutId || legacyId;
  const source = payload.source;
  const spawnParent = source && typeof source === 'object'
    ? nonEmptyString(source.subagent?.thread_spawn?.parent_thread_id)
    : undefined;
  // Modern metadata uses id for this rollout and session_id for its lineage.
  // Legacy records with only session_id still identify the current session.
  const parentId = spawnParent || (rolloutId ? legacyId : undefined);

  return {
    session_id: id,
    parentSessionId: parentId && parentId !== id ? parentId : undefined,
    cwd: payload.cwd,
    git_branch: payload.git_branch || payload.gitBranch,
    model: payload.model,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

