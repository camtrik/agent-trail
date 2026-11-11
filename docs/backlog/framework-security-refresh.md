---
type: chore
title: Refresh Framework Security Dependencies
status: todo
priority: p1
created: 2026-11-11
branch:
worktree:
---

## Description

当前锁定 Next.js 16.2.4/React 19.2.4。核查并升级到当前已修复安全问题的稳定版本，同步 eslint-config-next、React/DOM 与必要类型，避免顺带全量无关 major 升级。

## Acceptance criteria

- [ ] 使用官方发布元数据核实目标版本与 Node/pnpm 兼容性。
- [ ] package.json 与 pnpm-lock.yaml 一致，安装、类型、测试和两项构建通过。
- [ ] BFF、SSE、回放与双主题有运行验证。

## Related

- https://github.com/vercel/next.js/security/advisories/GHSA-pc58-hwjq-p385

