---
type: fix
title: Price Claude Usage Per Request
status: todo
priority: p2
created: 2026-11-11
branch:
worktree:
---

## Description

整合 PR #8 的官方 Claude 5.5 价格，但先修复分档语义。Haiku 100k 阈值包含缓存读写，必须先按请求计价再汇总，不能按 session 累计量选档。保留 source-reported 成本优先与 unknown/partial 语义。

## Acceptance criteria

- [ ] 官方价格、别名、缓存阈值上下边界有测试。
- [ ] 两个小请求的成本等于逐请求成本之和，不因会话累计量跨档。
- [ ] overview、sessions、模型/项目成本聚合一致；缺失请求数据不冒充精确结果。

## Related

- https://github.com/camtrik/agent-trail/pull/8
- https://platform.claude.com/docs/en/about-claude/pricing

