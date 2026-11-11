---
type: feat
title: Integrate Command Code History Adapter
status: review
priority: p2
created: 2026-11-11
branch: feat/commandcode-adapter
worktree: /Users/ebbi/.codex/worktrees/commandcode-adapter-implementation/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

第二批整合 PR #4。导入 Command Code v3 历史 transcript、标题、工具参数/结果、token 与记录成本，schema v23→v24 扩展 source。不得伪造未记录的子代理内部轨迹。

## Acceptance criteria

- [x] 保留贡献作者信息，新增 parser/source/migration 测试和全量验证通过。
- [x] 历史 v23 数据、索引、外键及重复启动迁移通过。
- [ ] 界面与 BFF 验收通过，部分成本明确标记 partial，文档说明子代理历史限制。

## Related

- https://github.com/camtrik/agent-trail/pull/4


## Notes

- 集成社区 PR #4，保留贡献者 `F-Stuckmann` 的 Co-authored-by 信息；未修改三份 README，由集成分支统一维护。
- 审查后修复标题 sidecar 缓存失效与 watcher 路径映射，覆盖标题改名、删除回退和重复同步；消息/工具 ID 使用 canonical source 前缀，避免跨来源冲突。
- v24 CHECK rebuild 保留历史数据、显式索引及触发器，恢复原有外键设置并执行 `foreign_key_check`；覆盖重复启动、新旧库一致性和级联行为。
- Command Code 回放以来源估算标注成本，说明 cache 已包含在 input；仅展示 transcript 保存的代理委派提示和结果，不伪造子代理内部历史。
- `partial` 来源成本由 parser 持久化，总览保留 partial 的共享 pricing 修复由同批 pricing 工作项统一整合。
- 验证：全量 783 项通过、1 项跳过；根目录与 ingest 两套 tsc 通过；改动 ESLint 无错误（仅既有 assembler 未使用参数警告）；HTTP 验证使用合成数据，ingest → Next BFF sessions/turns → 页面均成功。
- 待集成验收：浅色/深色实际截图检查未完成。Browser 工具的原生模块被 macOS 签名策略拒绝，备用 CUA 打开 Chrome 超时；新增内容沿用现有语义颜色 token。

- 交叉审查修复：v23 重建期间临时使用 `legacy_alter_table=ON` 与 `foreign_keys=OFF`，保留全局 view、嵌套 view 和其他表 trigger 对原表名的引用，迁移成功或失败后均恢复连接原设置。未删除或改写这些全局依赖；回归覆盖查询/触发结果、两项 pragma 的四种初始组合、外键检查失败后的完整 schema/data 回滚与修正后幂等重试。
