---
type: chore
title: Restore Quality Checks And Pull Request CI
status: wip
priority: p1
created: 2026-11-11
branch: chore/quality-check-baseline
worktree: /Users/ebbi/.codex/worktrees/quality-baseline-implementation/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

当前全量测试 5 失败；tracked TS/JS lint 82 errors、50 warnings。默认 lint 还扫描生成的发布产物与历史草稿。恢复有意义的基线并增加 PR 类型/测试/构建检查，避免通过关闭规则掩盖源代码问题。

## Acceptance criteria

- [ ] 5 项既有测试失败按行为修复或纠正已过时断言。
- [ ] lint 排除生成物、worktree 与历史草稿，源码 error 清零。
- [ ] PR CI 执行冻结锁文件安装、lint、两项 typecheck、测试与双服务构建。

