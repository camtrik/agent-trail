---
type: docs
title: Update Runtime And Compatibility Documentation
status: done
priority: p2
created: 2026-11-11
branch: chore/compatibility-refresh
worktree: /Users/ebbi/.codex/worktrees/compatibility-refresh/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

维护文档中的三来源/五来源、3000/3029/3030、8077/8078 和旧存储格式说明已漂移。待适配与端口实现确定后，统一启动、架构、API 与兼容矩阵；保留其他会话已有未提交文档改动。

## Acceptance criteria

- [x] 区分开发、npm 与 Docker 的实际启动地址和配置方法。
- [x] 标注各来源验证过的版本/格式与真实限制。
- [x] 三份 README 同步；中文主文档和英文镜像同步对应变化。

## Related

- [runtime-port-alignment.md](runtime-port-alignment.md)
- [openclaw-sqlite-storage.md](openclaw-sqlite-storage.md)
- [opencode-v2-schema.md](opencode-v2-schema.md)


## Integration validation

2026-11-11：review 后随本次 merge 落到本地 main。最终全量 847 passed / 1 skipped；lint 0 errors（48 条既有 warning），前端与 ingest typecheck、双服务生产构建通过；生产依赖审计 0。隔离五来源共 9 个 session 的 BFF/费用/四项血缘/页面/SSE 更新验证通过，schema v24 的 foreign_key_check 为 0。
