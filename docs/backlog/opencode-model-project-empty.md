---
type: fix
title: OpenCode model and project views show no data despite token consumption
status: todo
priority: p1
created: 2026-05-29
updated: 2026-11-11
branch:
worktree:
---

## Description

在 opencode 中使用了一些模型后，Dashboard 界面显示了 opencode 有消耗 token 的记录，但是 model 视图和 project 视图中都没有显示任何内容。

需要调查：
- opencode 的 JSONL 数据中 model 和 project 字段是否被正确解析
- 解析器是否处理了 opencode source 的 model/project 信息
- turns 组装器是否将这些字段传递到了前端
- 前端视图是否正确消费了这些字段

## Notes

- 确认当前目录能正常记录 opencode 的 token 消耗，ingest 链路本身没问题
- 切到 DeepSeek 后 model 视图全部显示为 DeepSeek，之前 GLM 的记录被覆盖了
- 推测根因：**同一 session 内切换 model 时，后一个 model 会覆盖前一个 model 的记录**，而非按 turn 独立记录
- 可能是 opencode JSONL 中 model 字段仅在 session 级别存在，或解析器取的是最新一条记录的 model 而非聚合所有出现过的 model
- 应顺带检查 Claude Code、Codex 等其他 tool source 是否有类似的同 session 切 model 覆盖问题

发现时间：2026-05-29 01:16 AM

## Acceptance criteria

相关存储适配见 [OpenCode v2 schema](_done/v0.2.0/opencode-v2-schema.md)。本项的跨模型/项目归属与“新版会话完全不可见”属于不同问题，需要分别验收。

- [ ] OpenCode source 的 JSONL 中 model/project 字段被正确提取
- [ ] Model 视图能展示 opencode 使用过的模型列表及其 token 消耗
- [ ] Project 视图能展示 opencode 涉及的项目及其活动
