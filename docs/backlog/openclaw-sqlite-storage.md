---
type: fix
title: Support Current OpenClaw Session Storage
status: review
priority: p1
created: 2026-11-11
branch: fix/openclaw-sqlite-storage
worktree: /Users/ebbi/.codex/worktrees/openclaw-sqlite-implementation/agents-tracing-dashboard
updated: 2026-11-11
---

## Description

官方当前文档将运行中会话与 transcript 放入 agents/<agentId>/agent/openclaw-agent.sqlite；现实现只扫描 sessions/*.jsonl。先核实已发布 schema 与消息存储接口，再增加当前存储适配并保留归档/旧 JSONL。

## Acceptance criteria

- [x] 有官方当前 schema/版本证据与脱敏 fixture，不凭空猜测表结构。
- [x] 运行中 SQLite 会话及 legacy/归档会话均可发现与回放，避免重复计数。
- [x] 只读、busy 退避、更新发现、schema 不兼容诊断均有验证。

## Related

- https://docs.openclaw.ai/concepts/session


## 实现与验证

- 官方证据固定到已发布的 `v2026.11.3`：
  - [agent schema](https://github.com/openclaw/openclaw/blob/v2026.11.3/src/state/openclaw-agent-schema.sql)
  - [transcript payload codec](https://github.com/openclaw/openclaw/blob/v2026.11.3/src/config/sessions/transcript-payload.ts)
  - [raw delta ordering](https://github.com/openclaw/openclaw/blob/v2026.11.3/src/config/sessions/session-accessor.sqlite-raw-delta-read.ts)
  - [session header](https://github.com/openclaw/openclaw/blob/v2026.11.3/src/config/sessions/transcript-header.ts)
- 增加只读 SQLite 适配器，复用 JSONL records 映射；只查询会话、窗口、祖先及 transcript 相关表，不读取认证/缓存表，不落地消息临时文件。
- 读取 `session_windows` 的每个历史/当前窗口，按 `seq` 排序并恢复 JSON/zstd 事件；保留工作区、状态、父子链、工具调用和结果、消息 token 与 source cost。节点汇总 token 不再次叠加。
- SQLite 优先同 ID JSONL；保留独立 legacy 与 `.deleted.*` / `.reset.*` / `.full.bak` 归档。发现计数与数据库同步均去重。
- 通过会话内容指纹跳过重复写入；watcher 观察 agent 根目录、新建数据库与 WAL/SHM 侧文件，按数据库范围刷新窗口。
- 只读快照设置 300ms busy timeout，最多三次读取尝试，重试间隔 100ms；未知表/列报告版本化 schema 诊断。
- 10 个相关套件共 109 tests passed；补充缺失 JSONL graceful error 回归后，相关 21 tests passed；前端与 ingest 两项 typecheck 通过；新增模块及相关改动定向 ESLint 无问题。受工作区磁盘容量限制，本分支未重复运行 Next 构建，由主集成统一执行。

## 当前边界

- 支持热 transcript 的 JSON 与 zstd、以及已导出的 JSONL 归档。`session_transcript_cold_archives` 检测后明确标记 partial，不用 navigation 投影伪造正文；独立 `session_transcript_archives` 中尚未导出为 JSONL 的归档暂未解码。发现接口返回 archive owner 计数与 warning，source health 为 `parser-warning`，同步状态也记录该限制；只有 archive 行时不会被当成完全正常的空来源。
- zstd 使用运行时能力检测；缺少解码能力的旧 Node 22 保留可读 JSON 事件并报告 partial 与版本提示，不改变现有 npm Node >=22 声明。
- 当前数据库文件变化会检查该数据库内的窗口，尚未实现 SQL 增量游标；内容指纹保证同一窗口不因 WAL 或旧导出重复写入/计数。
