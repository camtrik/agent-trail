---
type: fix
title: Preserve Codex Rollout Identity And Lineage
status: todo
priority: p1
created: 2026-11-11
branch:
worktree:
---

## Description

处理 issue #1。现代 session_meta 的 payload.id 是物理 rollout ID，payload.session_id 与 source.subagent.thread_spawn.parent_thread_id 描述血缘，不能使子会话覆盖父会话。需要同时校验完整/增量解析、游标、关系补全与历史重建。

## Acceptance criteria

- [ ] 共享父 ID 的多个 rollout 保持独立会话和索引游标。
- [ ] 父子/root 关系及旧格式兼容均有回归测试。
- [ ] 重复累计 token_count 不增加用量；恢复历史索引不覆盖源文件。

## Related

- https://github.com/camtrik/agent-trail/issues/1
- [session-token-missing-subagent.md](session-token-missing-subagent.md)

