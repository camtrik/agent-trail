---
type: fix
title: Price Claude Usage Per Request
status: review
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
