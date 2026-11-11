---
type: chore
title: Validate Current Qoder Storage Compatibility
status: todo
priority: p2
created: 2026-11-11
branch:
worktree:
---

## Description

当前适配器针对旧 IDE local.db；核查当前 IDE/Desktop/CLI 的公开存储与脱敏 schema，明确可支持范围。不能由现有 fixture 推断所有新版产品兼容，也不能回退读取凭据或缺失关键字段的旧 JSONL。

## Acceptance criteria

- [ ] 记录最新可验证版本、产品差异及 schema 证据。
- [ ] 可获得的当前脱敏 fixture 通过 parser/source 验证，必要时补 schema 能力诊断。
- [ ] 不读取 machine_token.json、supabase_token、state.vscdb 或其他凭据存储。

## Evidence

2026-11-11 仅检查本机应用版本及允许读取的三张聊天表的列信息：安装的 Qoder 为 1.7.0，旧库仍为 chat_session/chat_record/chat_message。未读取消息正文、认证表或凭据文件。

官方当日发布记录列出 IDE 1.39.2、CLI 1.1.86；本机旧库不能证明这两种当前产品的存储兼容性。保留 todo，后续需要当前版本的公开 schema 或脱敏 fixture；文档明确旧 IDE schema 的验证范围，不宣称新版 Desktop/CLI 已适配。

## Related

- https://changelog.qoder.com/ide
- https://changelog.qoder.com/cli

