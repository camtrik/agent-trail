---
type: fix
title: Ignore Claude Request Snapshot Records
status: review
priority: p1
created: 2026-11-11
branch: chore/compatibility-refresh
worktree: /Users/ebbi/.codex/worktrees/compatibility-refresh/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

整合 PR #7，防止 api-request-blob/api-request 中重复的工具调用与缺失 UUID 破坏完整会话入库。全量与增量解析均应跳过，缓存需失效并保留可诊断错误。

## Acceptance criteria

- [ ] 全量、增量解析的快照不会创建消息或重复工具调用。
- [ ] 旧缓存触发重新解析；同步错误有明确日志。
- [ ] 相关 parser/sync 回归测试通过。

## Related

- https://github.com/camtrik/agent-trail/pull/7


## Validation

2026-11-11：相关 parser/config 测试 69 项通过，前端与 ingest 类型检查通过；等待集成验收。
