---
type: fix
title: Session Token Count Missing Subagent Consumption
status: todo
priority: p1
created: 2026-05-30
updated: 2026-11-11
branch:
worktree:
---

## Description

Session 级别的 token 统计没有包含 subagent 消耗的 token。典型 session 如 `95672086-ce0f-476b-bbee-c02ea55e99a3`，session 内派发了多个 subagent，每个 subagent 都有可观的 token 消耗，但这些子任务的 token 没有汇总到 session 总 token 中。

需要调查：

- 各 tool source（OpenClaw、Claude Code、Codex）的 JSONL 中 subagent 的 token 记录格式
- Parser 是否识别并提取了 subagent 的 token 字段
- Turns 组装器 / 聚合逻辑是否按 `parent_session_id` 或等效字段归并 subagent token
- DB 表结构是否需要调整以正确归属 subagent → parent session 的 token
- Dashboard 前端展示是否反映了 subagent token

## Acceptance criteria

- [ ] Subagent 的 token 消耗被正确解析并写入 DB
- [ ] Session 总 token = 主 session token + 所有 subagent token 之和
- [ ] 以 session `95672086-ce0f-476b-bbee-c02ea55e99a3` 验证：token 计数应明显高于当前值
- [ ] 至少覆盖 OpenClaw source 的 subagent token 聚合（如其他 source 无 subagent 概念则不受影响）

## Related

- [Codex rollout 身份与血缘修复](_done/v0.2.0/codex-rollout-identity.md) 处理不同子 rollout 被写成父会话、独立 token 丢失的问题。父级界面展示含子会话总数仍由本项负责，不因身份修复而自动完成。
- 父级含子聚合与各物理 session 自身用量应区分，避免全局汇总再次重复累计子代理消耗。
