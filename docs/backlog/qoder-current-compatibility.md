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

## Related

- https://changelog.qoder.com/ide
- https://changelog.qoder.com/cli

