---
type: fix
title: Decode OpenClaw Cold Transcript Archives
status: todo
priority: p2
created: 2026-11-11
branch:
worktree:
---

## Description

热 SQLite 适配已支持 session_windows/transcript_events 的 JSON/zstd 和 legacy/已导出归档 JSONL。v2026.11.3 的 session_transcript_cold_archives 与独立 session_transcript_archives blob 尚未解码，当前只统计并显示 parser-warning/partial，不能将导航投影冒充正文。

继续按对应官方 release 的 codec、generation 与 archive 身份契约实现冷归档读取；仅有独立 archive 行时也应可发现历史。外部数据库保持只读，不主动导出或修复用户上游状态。

## Acceptance criteria

- [ ] 使用官方 codec/版本证据与脱敏 identity/zstd blob fixture。
- [ ] 窗口冷存储与独立 deleted/reset archive 都能还原，验证长度/校验和/顺序。
- [ ] active、cold 与导出 JSONL 同时存在时不重复索引或覆盖较完整历史。
- [ ] 未知编码或损坏 blob 继续提供明确诊断，原始数据不修改。

## Related

- [热存储适配](openclaw-sqlite-storage.md)
- https://github.com/openclaw/openclaw/blob/v2026.11.3/src/state/openclaw-agent-schema.sql
