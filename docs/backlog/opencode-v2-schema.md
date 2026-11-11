---
type: fix
title: Support OpenCode V2 Storage Schema
status: todo
priority: p1
created: 2026-11-11
branch:
worktree:
---

## Description

合并处理 issue #2/#3。识别 legacy session/message/part 与 v2 session_v2/session_message 两种 schema，并支持并存数据库，不能因旧表为空而忽略新版会话。

## Acceptance criteria

- [ ] 旧库、新库、混合库均能发现、同步、搜索并回放会话。
- [ ] 按 seq 还原 v2 消息，保留工具、token、cost、父子关系，不重复计数。
- [ ] 以只读方式读取外部库，并覆盖缓存失效、迁移边界与 schema 错误。

## Related

- https://github.com/camtrik/agent-trail/issues/2
- https://github.com/camtrik/agent-trail/issues/3
- [opencode-model-project-empty.md](opencode-model-project-empty.md)

