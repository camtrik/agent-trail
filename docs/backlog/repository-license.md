---
type: docs
title: Clarify Repository License Coverage
status: todo
priority: p2
created: 2026-11-11
branch:
worktree:
---

## Description

处理 issue #5。README/网站/npm 宣称 MIT，源码无根 LICENSE 与 package license，发布脚本默认填 MIT。统一声明与发布内容，并明确已有资产的单独条款。

## Acceptance criteria

- [ ] 补齐根许可证与源码 package.json 的一致声明。
- [ ] 发布包包含许可证，不静默猜测缺失的 license。
- [ ] 确认授权覆盖范围与第三方资产归属；README 改动同步三种语言。

## Related

- https://github.com/camtrik/agent-trail/issues/5

