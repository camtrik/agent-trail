---
type: docs
title: Clarify Repository License Coverage
status: review
priority: p2
created: 2026-11-11
branch: chore/compatibility-refresh
worktree: /Users/ebbi/.codex/worktrees/compatibility-refresh/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

处理 issue #5。README/网站/npm 宣称 MIT，源码无根 LICENSE 与 package license，发布脚本默认填 MIT。统一声明与发布内容，并明确已有资产的单独条款。

## Acceptance criteria

- [ ] 补齐根许可证与源码 package.json 的一致声明。
- [ ] 发布包包含许可证，不静默猜测缺失的 license。
- [ ] 确认授权覆盖范围与第三方资产归属；README 改动同步三种语言。

## Related

- https://github.com/camtrik/agent-trail/issues/5


## Notes

沿用现有 README、网站与 npm 包的 MIT 授权意图：补齐根 LICENSE 与源 package license。打包前要求显式许可证和正文，不再静默默认 MIT；三语言授权范围说明随兼容文档统一更新。
