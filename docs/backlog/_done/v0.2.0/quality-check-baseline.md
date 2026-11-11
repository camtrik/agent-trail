---
type: chore
title: Restore Quality Checks And Pull Request CI
status: done
priority: p1
created: 2026-11-11
branch: chore/quality-check-baseline
worktree: /Users/ebbi/.codex/worktrees/quality-baseline-implementation/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

当前全量测试 5 失败；tracked TS/JS lint 82 errors、50 warnings。默认 lint 还扫描生成的发布产物与历史草稿。恢复有意义的基线并增加 PR 类型/测试/构建检查，避免通过关闭规则掩盖源代码问题。

## Acceptance criteria

- [x] 5 项既有测试失败按行为修复或纠正已过时断言。
- [x] lint 排除生成物、worktree 与历史草稿，源码 error 清零。
- [x] PR CI 执行冻结锁文件安装、lint、两项 typecheck、测试与双服务构建。


## 实现与验证

- 五项既有失败均为过时测试合约：品牌缩写、活动文案、元数据搜索范围、debug 日志通道。未扩展搜索业务范围。
- lint 排除发布生成物、ingest 构建输出、隔离 worktree、历史规划草稿和覆盖率目录；保留源码与测试检查。
- 通过具体数据库行类型、Claude 内容块类型与 Vitest mock 类型移除源码 `any`；删除未引用的旧 Claude tool-call helper。
- hydration 标记使用 server/client snapshot，并新增 SSR hydration 回归测试。
- PR CI 使用 Node 24、pnpm 11.1.3，执行冻结安装、lint、两项类型检查、全量测试和双服务构建。
- 本分支验证：743 tests passed、1 optional local-corpus test skipped；两项 typecheck、`pnpm build:all`（Next + ingest）通过。
- lint 剩余 48 warnings（未使用声明与一项已有 img 提示），未关闭规则。尚余 CodexJsonlLine 两项类型错误由并行 Codex 合约适配分支处理，集成时复核 error 清零。

## Integration validation

2026-11-11：review 后随本次 merge 落到本地 main。最终全量 847 passed / 1 skipped；lint 0 errors（48 条既有 warning），前端与 ingest typecheck、双服务生产构建通过；生产依赖审计 0。隔离五来源共 9 个 session 的 BFF/费用/四项血缘/页面/SSE 更新验证通过，schema v24 的 foreign_key_check 为 0。
