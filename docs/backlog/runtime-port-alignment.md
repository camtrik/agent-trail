---
type: fix
title: Align Runtime Port Configuration
status: done
priority: p1
created: 2026-11-11
branch: chore/compatibility-refresh
worktree: /Users/ebbi/.codex/worktrees/compatibility-refresh/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

整合 PR #6 的端口修复。当前脚本强制 ingest 监听 8077，BFF 与配置默认 8078；使用配置默认值并允许 INGEST_PORT 覆盖，不引入与 pnpm allowBuilds 重复的 allowScripts。

## Acceptance criteria

- [x] 无环境变量时 ingest 与 BFF 使用同一默认端口。
- [x] 自定义 INGEST_PORT 能同时作用于两项服务。
- [x] 开发、生产启动脚本及对应配置验证通过。

## Related

- https://github.com/camtrik/agent-trail/pull/6


## Validation

2026-11-11：相关 parser/config 测试 69 项通过，前端与 ingest 类型检查通过；等待集成验收。

## Integration validation

2026-11-11：review 后随本次 merge 落到本地 main。最终全量 847 passed / 1 skipped；lint 0 errors（48 条既有 warning），前端与 ingest typecheck、双服务生产构建通过；生产依赖审计 0。隔离五来源共 9 个 session 的 BFF/费用/四项血缘/页面/SSE 更新验证通过，schema v24 的 foreign_key_check 为 0。
