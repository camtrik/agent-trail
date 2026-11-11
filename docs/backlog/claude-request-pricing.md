---
type: fix
title: Price Claude Usage Per Request
status: done
priority: p2
created: 2026-11-11
branch: fix/claude-request-pricing
worktree: /Users/ebbi/.codex/worktrees/claude-pricing-implementation/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

整合 PR #8 的官方 Claude 5.5 价格，但先修复分档语义。Haiku 100k 阈值包含缓存读写，必须先按请求计价再汇总，不能按 session 累计量选档。保留 source-reported 成本优先与 unknown/partial 语义。

## Acceptance criteria

- [x] 官方价格、别名、缓存阈值上下边界有测试。
- [x] 两个小请求的成本等于逐请求成本之和，不因会话累计量跨档。
- [x] overview、sessions、模型/项目成本聚合一致；缺失请求数据不冒充精确结果。

## Related

- https://github.com/camtrik/agent-trail/pull/8
- https://platform.claude.com/docs/en/about-claude/pricing


## Notes

- 按官方 2026-11-11 文档加入 Opus/Sonnet/Haiku 5.5 价格与别名；缓存创建使用 5 分钟费率。Haiku 按每次请求的未缓存输入、缓存读写合计选择 100k 档位。
- Claude API `message.id` 随 token usage 持久化；同请求的不同 UUID 累计快照合并，先计每个请求再汇总，最后统一舍入。旧数据缺请求身份时 Haiku 5.5 返回 unknown/partial，需重新 ingest 才能补齐身份。
- sessions、overview aggregates/daily/model/project 共用请求成本；混合模型与每日归属按请求处理。来源成本（包括明确为零）优先，来源 partial 和缺 usage/model 的 partial 状态不丢失。
- 新增阈值与缓存边界、两个小请求、模型切换、多日与重复快照、缺身份/usage/时间、来源零成本/partial、跨 provider token overlap 等回归。
- 保留 PR #8 作者署名：B-Stewart <7998805+B-Stewart@users.noreply.github.com>。

## 补充验证（Pricing Completeness）

- 分支 `fix/pricing-completeness` 修复复审边界：CommandCode 等来源的逐请求 `sourceCostUsd` 按真实日期分配，先合并相同请求快照并核对来源会话总额，缺成本/日期或不一致时返回 unknown/partial。全时总览继续使用每个会话的来源总成本；没有逐条成本证据时，不再把按 token 比例估算的每日成本标为精确。
- 无 usage 的 Claude 内容块独立保存请求 ID（JSON 仅含身份，不制造零 token）；同请求块不增加未知请求，独立缺失请求令已知成本保持 partial。turn assembler/API 会将身份与实际 usage 分开读取。
- 完整来源零成本可推断所有已知模型成本为零；partial 零总成本不能推断模型完整成本。固定费率历史会话成本在汇总后再舍入。
- 回归覆盖两天逐消息成本 1/0.01、相同请求重复快照、缺成本/缺日期、缺 usage 但总 token 恰好匹配、无 usage 身份持久化、完整/partial 零、多会话微额汇总。

- 本轮验证：7 个相关测试文件共 148 项通过，frontend/ingest 两个 TypeScript 检查通过，修改相关 lint 无错误。全量 834 项通过、1 项跳过；另一个 OpenCode 混合布局首次同步测试暴露既有父子外键失败，交集成分支统一修复。

## Integration validation

2026-11-11：review 后随本次 merge 落到本地 main。最终全量 847 passed / 1 skipped；lint 0 errors（48 条既有 warning），前端与 ingest typecheck、双服务生产构建通过；生产依赖审计 0。隔离五来源共 9 个 session 的 BFF/费用/四项血缘/页面/SSE 更新验证通过，schema v24 的 foreign_key_check 为 0。
