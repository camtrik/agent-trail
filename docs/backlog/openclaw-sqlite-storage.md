---
type: fix
title: Support Current OpenClaw Session Storage
status: todo
priority: p1
created: 2026-11-11
branch:
worktree:
---

## Description

官方当前文档将运行中会话与 transcript 放入 agents/<agentId>/agent/openclaw-agent.sqlite；现实现只扫描 sessions/*.jsonl。先核实已发布 schema 与消息存储接口，再增加当前存储适配并保留归档/旧 JSONL。

## Acceptance criteria

- [ ] 有官方当前 schema/版本证据与脱敏 fixture，不凭空猜测表结构。
- [ ] 运行中 SQLite 会话及 legacy/归档会话均可发现与回放，避免重复计数。
- [ ] 只读、busy 退避、更新发现、schema 不兼容诊断均有验证。

## Related

- https://docs.openclaw.ai/concepts/session

