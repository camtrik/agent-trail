---
type: fix
title: Align Runtime Port Configuration
status: todo
priority: p1
created: 2026-11-11
branch:
worktree:
---

## Description

整合 PR #6 的端口修复。当前脚本强制 ingest 监听 8077，BFF 与配置默认 8078；使用配置默认值并允许 INGEST_PORT 覆盖，不引入与 pnpm allowBuilds 重复的 allowScripts。

## Acceptance criteria

- [ ] 无环境变量时 ingest 与 BFF 使用同一默认端口。
- [ ] 自定义 INGEST_PORT 能同时作用于两项服务。
- [ ] 开发、生产启动脚本及对应配置验证通过。

## Related

- https://github.com/camtrik/agent-trail/pull/6

