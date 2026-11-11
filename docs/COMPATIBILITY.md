# 运行与数据兼容性

本文记录 2026-11-11 维护批次的实现与验证范围。未发布的主线改动不会自动更新已安装的 v0.1.7；发布前请从源码构建。

## 运行方式

推荐使用 Node.js 24 与 package.json 指定的 pnpm 11.1.3。npm 分发包的最低 Node 版本以其 engines 字段为准；压缩 transcript 的运行时要求和降级诊断见对应适配器。

| 方式 | 前端地址 | ingest 默认端口 |
| --- | --- | --- |
| 源码 pnpm dev / pnpm start:all | http://localhost:3029 | 8078 |
| npm 包 agent-trail | http://localhost:3030 | 8078 |
| Docker / Compose | http://localhost:3030 | 8078 |

INGEST_PORT 应作为启动进程的环境变量提供，例如 `INGEST_PORT=8081 pnpm dev`，由 ingest 和 BFF 共同继承；INGEST_URL 可以显式覆盖 BFF 的上游地址。Next.js 会读取 .env.local，独立 ingest 进程不会自动读取它。多数据源路径优先使用 ~/.agent-trail/config.json，或 export 对应环境变量。

源代码脚本显式使用前端 3029。需要另一个开发端口时，分别运行 `INGEST_PORT=8081 pnpm dev:ingest` 和 `INGEST_PORT=8081 pnpm exec next dev --webpack --port 3031`。npm/Docker 的前端端口通过 PORT 配置。

## 已覆盖的数据格式

以下验证使用官方 schema 与脱敏合成 fixture，不代表逐个运行了所有最新上游产品。

| 来源 | 已覆盖格式 | 限制 |
| --- | --- | --- |
| Claude Code | JSONL 消息、工具/子代理；跳过 api-request 和 api-request-blob 快照 | 分档成本需要请求身份与 usage，缺失时保留 unknown/partial |
| Codex | legacy 与 payload 元数据；id 为物理 rollout 身份，session_id / thread_spawn 为血缘 | 缺少父文件时先保留独立子会话，后续同步补全关系 |
| OpenCode | legacy session/message/part；2.x session_v2/session_message；当前分拆 session_part | 两套表并存时同 ID 的 v2 版本优先；未知 schema 明确报错 |
| OpenClaw | legacy/归档 JSONL 与 v2026.11.3 的每 agent SQLite 存储 | 热事件支持 JSON/zstd；cold/独立 archive blob 暂不解码，并显示 parser-warning/partial，不能用导航摘要冒充正文 |
| Command Code | v3 历史 JSONL、标题 sidecar、工具参数/结果、记录的 usage/cost | 未记录的子代理内部消息不能恢复；父模型成本不代表全部子代理成本 |
| Qoder | 旧 IDE local.db 的 chat_session/chat_record/chat_message | 本机仅核验 Qoder 1.7.0 的表结构；当前 IDE/Desktop/CLI 尚待新版本 schema/fixture 验证 |

OpenClaw 默认数据库为 ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite；旧 sessions 目录仍用于归档。OpenCode 默认数据库为 ~/.local/share/opencode/opencode.db。两种外部数据库均只读访问。

## 索引和费用

解析器升级通过缓存版本使旧索引失效。可以从界面刷新，或向对应 BFF sync 路由提交 `{"force":true}` 重新解析；不要先删除 ingest.db，以免丢失收藏等本地元数据。原始会话文件和上游数据库不会被改写。

成本优先使用数据源记录值；模型价格属于估算。Claude Haiku 5.5 的 100k 分档针对每次请求的全部输入（含缓存读写），按请求估价后汇总。不能用整段会话的累计 token 选择请求档位，也不能把缺少 usage 的请求当零成本。

## 维护检查

PR CI 运行冻结锁文件安装、lint、两项 typecheck、测试与双服务构建。真实本地语料库测试属于显式启用的额外验证，不会在 CI 读取用户会话。

项目自有源码、文档和品牌资产按根目录 LICENSE 的 MIT 条款发布。第三方依赖保留各自许可证；发布脚本要求显式许可证与正文，不再静默猜测授权。

## 官方依据

- [OpenClaw 会话存储](https://docs.openclaw.ai/concepts/session) 与 [v2026.11.3 schema](https://github.com/openclaw/openclaw/blob/v2026.11.3/src/state/openclaw-agent-schema.sql)
- [OpenCode session schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts)
- [Claude 计价](https://platform.claude.com/docs/en/about-claude/pricing)
- [Qoder IDE](https://changelog.qoder.com/ide) 与 [CLI](https://changelog.qoder.com/cli) 发布记录
