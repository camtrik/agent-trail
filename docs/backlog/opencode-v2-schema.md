---
type: fix
title: Support OpenCode V2 Storage Schema
status: review
priority: p1
created: 2026-11-11
branch: fix/opencode-v2-schema
worktree: /Users/ebbi/.codex/worktrees/opencode-v2-implementation/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

合并处理 issue #2/#3。识别 legacy session/message/part 与 v2 session_v2/session_message 两种 schema，并支持并存数据库，不能因旧表为空而忽略新版会话。

## Acceptance criteria

- [x] 旧库、新库、混合库均能发现、同步、搜索并回放会话。
- [x] 按 seq 还原 v2 消息，保留工具、token、cost、父子关系，不重复计数。
- [x] 以只读方式读取外部库，并覆盖缓存失效、迁移边界与 schema 错误。

## Related

- https://github.com/camtrik/agent-trail/issues/2
- https://github.com/camtrik/agent-trail/issues/3
- [opencode-model-project-empty.md](opencode-model-project-empty.md)


## Notes

- 统一识别 legacy、v2 与混合库；同 ID 的 v2 记录优先，分拆 `session_part` 与 inline content 按上游顺序拼接。
- v2 消息按 `seq` 排序，`idle` 划定 turn 边界；保留工具输入/结果/错误、消息模型、session usage/cost 与 parent/fork 关系。
- 只更新 OpenCode 独立 skip-key 版本；缓存指纹包含存储布局、session 元数据、消息与分拆正文计数/更新时间。
- 外部库只读，busy timeout 300ms、最多 3 次读取尝试；不完整 schema 给出缺表/缺列诊断，坏消息不覆盖已同步数据。
- 已核实官方源码（2026-11-11）：[sql.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts)、[session-message.ts](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-message.ts)、[stored.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/stored.ts)、[history.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/history.ts)。fixture 为手写合成数据，不含用户会话内容。
- 验证：6 个定向测试文件共 56 项通过；根目录与 ingest 两套 TypeScript 检查、修改文件 ESLint 与 `git diff --check` 通过。
