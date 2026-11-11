---
type: fix
title: Preserve Codex Rollout Identity And Lineage
status: review
priority: p1
created: 2026-11-11
branch: fix/codex-rollout-identity
worktree: /Users/ebbi/.codex/worktrees/codex-identity-implementation/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

处理 issue #1。现代 session_meta 的 payload.id 是物理 rollout ID，payload.session_id 与 source.subagent.thread_spawn.parent_thread_id 描述血缘，不能使子会话覆盖父会话。需要同时校验完整/增量解析、游标、关系补全与历史重建。

## Acceptance criteria

- [x] 共享父 ID 的多个 rollout 保持独立会话和索引游标。
- [x] 父子/root 关系及旧格式兼容均有回归测试。
- [x] 重复累计 token_count 不增加用量；恢复历史索引不覆盖源文件。

## Related

- https://github.com/camtrik/agent-trail/issues/1
- [session-token-missing-subagent.md](session-token-missing-subagent.md)


## Notes

- 完整与增量解析均优先使用物理 rollout `id`；metadata 的 `session_id` 与显式 spawn parent 用于血缘。
- 同步支持子会话先入库、多级 root 补全、缺失父会话后续恢复，并清理同源同路径的旧身份派生记录。原始 rollout 与父会话 star 键不改动。
- 新增 11 项回归测试，覆盖独立游标、完整/增量 token 快照去重、legacy 兼容与历史缓存修复。定向既有 Codex/sync 53 项通过，两个 TypeScript 检查通过。
- 父 rollout 尚未 ingest 时不创建占位父会话；下次完整同步只为未解析血缘的子会话读取 metadata header，父会话到齐后补全。
