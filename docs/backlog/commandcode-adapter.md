---
type: feat
title: Integrate Command Code History Adapter
status: todo
priority: p2
created: 2026-11-11
branch:
worktree:
---

## Description

第二批整合 PR #4。导入 Command Code v3 历史 transcript、标题、工具参数/结果、token 与记录成本，schema v23→v24 扩展 source。不得伪造未记录的子代理内部轨迹。

## Acceptance criteria

- [ ] 保留贡献作者信息，新增 parser/source/migration 测试和全量验证通过。
- [ ] 历史 v23 数据、索引、外键及重复启动迁移通过。
- [ ] 界面与 BFF 验收通过，部分成本明确标记 partial，文档说明子代理历史限制。

## Related

- https://github.com/camtrik/agent-trail/pull/4

