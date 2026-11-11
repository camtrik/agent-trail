---
type: chore
title: Refresh Framework Security Dependencies
status: done
priority: p1
created: 2026-11-11
branch: chore/compatibility-refresh
worktree: /Users/ebbi/.codex/worktrees/compatibility-refresh/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

当前锁定 Next.js 16.2.4/React 19.2.4。核查并升级到当前已修复安全问题的稳定版本，同步 eslint-config-next、React/DOM 与必要类型，避免顺带全量无关 major 升级。

## Acceptance criteria

- [x] 使用官方发布元数据核实目标版本与 Node/pnpm 兼容性。
- [x] package.json 与 pnpm-lock.yaml 一致，安装、类型、测试和两项构建通过。
- [x] BFF、SSE、回放与双主题有运行验证。

## Related

- https://github.com/vercel/next.js/security/advisories/GHSA-pc58-hwjq-p385


## Dependency audit

2026-11-11：Next/React 更新后继续审计生产依赖，发现 33 条公告（5 high）。同步升级 Hono 4.13.17、node-server 2.1.6、ws 8.22.2，并刷新受影响的间接依赖；复查 0 条。Hono/node-server 选择已超过发布冷却期的修复版本，未保留 pnpm 自动添加的新版本冷却豁免。

## Integration validation

2026-11-11：review 后随本次 merge 落到本地 main。最终全量 847 passed / 1 skipped；lint 0 errors（48 条既有 warning），前端与 ingest typecheck、双服务生产构建通过；生产依赖审计 0。隔离五来源共 9 个 session 的 BFF/费用/四项血缘/页面/SSE 更新验证通过，schema v24 的 foreign_key_check 为 0。
