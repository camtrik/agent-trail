---
type: fix
title: Ignore Claude Request Snapshot Records
status: done
priority: p1
created: 2026-11-11
branch: chore/compatibility-refresh
worktree: /Users/ebbi/.codex/worktrees/compatibility-refresh/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

整合 PR #7，防止 api-request-blob/api-request 中重复的工具调用与缺失 UUID 破坏完整会话入库。全量与增量解析均应跳过，缓存需失效并保留可诊断错误。

## Acceptance criteria

- [x] 全量、增量解析的快照不会创建消息或重复工具调用。
- [x] 旧缓存触发重新解析；同步错误有明确日志。
- [x] 相关 parser/sync 回归测试通过。

## Related

- https://github.com/camtrik/agent-trail/pull/7


## Validation

2026-11-11：相关 parser/config 测试 69 项通过，前端与 ingest 类型检查通过；等待集成验收。

## Integration validation

2026-11-11：review 后随本次 merge 落到本地 main。最终全量 847 passed / 1 skipped；lint 0 errors（48 条既有 warning），前端与 ingest typecheck、双服务生产构建通过；生产依赖审计 0。隔离五来源共 9 个 session 的 BFF/费用/四项血缘/页面/SSE 更新验证通过，schema v24 的 foreign_key_check 为 0。
