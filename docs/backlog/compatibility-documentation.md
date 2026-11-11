---
type: docs
title: Update Runtime And Compatibility Documentation
status: todo
priority: p2
created: 2026-11-11
branch:
worktree:
---

## Description

维护文档中的三来源/五来源、3000/3029/3030、8077/8078 和旧存储格式说明已漂移。待适配与端口实现确定后，统一启动、架构、API 与兼容矩阵；保留其他会话已有未提交文档改动。

## Acceptance criteria

- [ ] 区分开发、npm 与 Docker 的实际启动地址和配置方法。
- [ ] 标注各来源验证过的版本/格式与真实限制。
- [ ] 三份 README 同步；中文主文档和英文镜像同步对应变化。

## Related

- [runtime-port-alignment.md](runtime-port-alignment.md)
- [openclaw-sqlite-storage.md](openclaw-sqlite-storage.md)
- [opencode-v2-schema.md](opencode-v2-schema.md)

