# 配置

agent-trail 通过环境变量和可选的配置文件进行配置。数据源目录支持三层解析优先级：**环境变量 > config.json > 内置默认值**。两个服务在启动时解析 `process.env`。本文档列出了代码实际读取的每个变量、读取位置、默认值以及对其进行的校验。

> **约定。** 以 `NEXT_PUBLIC_` 为前缀的变量由 Next.js 暴露给浏览器打包文件 — 切勿将密钥放在其中。以 `INGEST_` 为前缀的变量仅由摄取服务读取。没有前缀的变量（例如 `WORKSPACE_PATH`）由两个服务共同读取。

---

## 1. 值的存放位置

| 文件 | 加载方式 | 是否提交？ |
| --- | --- | --- |
| `.env.local` | Next.js 自动加载；摄取服务通过 `pnpm dev:ingest` 启动时继承父 shell 环境 | 否（gitignore 中 — 参见 `.gitignore`） |
| `~/.agent-trail/config.json` | `ingest/config/tool-dirs.ts → loadConfigFile` — 数据源目录的多路径配置 | 否（用户主目录） |
| Shell 导出 / 启动脚本 | 两个服务直接启动时 | 不适用 |
| `.ovao-config.json` | `lib/gateway-config.ts`（Gateway URL/Token 持久化） | 否（gitignore 中）— 运行时管理，请勿手动编辑 |

仓库中**没有**签入 `.env.example`。最小的本地设置参见 [`GETTING-STARTED.md`](GETTING-STARTED.md)。

---

## 2. 数据源发现（Tool Directory Registry）

数据源目录通过 `ingest/config/tool-dirs.ts` 中的 `TOOL_DIR_REGISTRY` 和 `resolveToolDirs()` 进行集中管理。支持三层解析优先级：**环境变量 > config.json > 内置默认值**。目前支持四种数据源：OpenClaw、Claude Code、Codex（JSONL 文件）和 OpenCode（SQLite 数据库）。

### `AGENT_TRAIL_CONFIG`

- **默认值：** `~/.agent-trail/config.json`。
- **读取位置：** `ingest/config/tool-dirs.ts → loadConfigFile`。
- **用途：** 覆盖配置文件路径。若未设置，则优先读取 `~/.agent-trail/config.json`；如果不存在，会回退到旧路径 `~/.agents-tracing/config.json`。两个文件都不存在时静默忽略（返回 `null`）。
- **兼容：** 旧变量 `AGENTS_TRACING_CONFIG` 仍可使用，但新文档统一使用 `AGENT_TRAIL_CONFIG`。

### `OPENCLAW_DIR`

- **默认值：** `~/.openclaw/agents`。
- **config.json 键：** `openclaw_dirs`（数组，支持多路径）。
- **读取位置：** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`。
- **解析为：** `<dir>/<agent-name>/agent/openclaw-agent.sqlite` 及 `sessions/` 下的 legacy/已导出归档 JSONL。
- **路径限制：** 发现的路径会通过 `isWithinRoot` 对照解析后的根目录进行校验。任何在根目录之外的路径会被丢弃，并在摄取日志中输出 `[sources] Rejected path outside root: ...`。

### `CLAUDE_PROJECTS_DIR`

- **默认值：** `~/.claude/projects`。
- **config.json 键：** `claude_project_dirs`（数组，支持多路径）。
- **读取位置：** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`。
- **解析为：** 根目录下任何包含 `.jsonl` 文件的目录（递归发现）。
- **项目提取：** Claude 通过在目录名中将 `/` 替换为 `-` 来编码原始 `cwd`（例如 `-Users-ebbi-work-foo`）。同步层会将其解码回 `project` 列。

### `CODEX_SESSIONS_DIR`

- **默认值：** `~/.codex/sessions`。
- **config.json 键：** `codex_sessions_dirs`（数组，支持多路径）。
- **读取位置：** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`。
- **解析为：** 根目录下任何包含 `.jsonl` 文件的目录（递归）。Codex 的父子关系在同步期间根据 `session_meta` 血缘元数据及 `event_msg.collab_agent_spawn_end` 事件重建。

### `OPENCODE_DB_PATH`

- **默认值：** `~/.local/share/opencode/opencode.db`。
- **config.json 键：** `opencode_db_paths`（数组）。
- **读取位置：** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`。
- **解析为：** OpenCode 的 SQLite 数据库文件（不是 JSONL 文件目录）。解析器以只读方式打开此数据库，按 schema 读取 legacy `session/message/part` 或 v2 `session_v2/session_message`（含可选 `session_part`），保留 `project` 元数据。
- **注意：** OpenCode 将会话数据存储在 SQLite 中，而不是 JSONL 文件。此路径指向单个 `.db` 文件。

### `COMMANDCODE_PROJECTS_DIR`

默认 `~/.commandcode/projects`，config.json 键为数组 `commandcode_project_dirs`。只导入 v3 历史 transcript 与标题 sidecar；`~/.commandcode/sessions` 的 hook 遥测不是聊天数据源。限制见 [COMPATIBILITY.md](COMPATIBILITY.md)。

### `QODER_DB_PATH`

- **默认值：** `~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db`（macOS）。
- **config.json 键：** `qoder_db_paths`（数组，支持多路径）。
- **读取位置：** `ingest/config/tool-dirs.ts → TOOL_DIR_REGISTRY`、`ingest/sync/sources.ts → discoverQoderSources`。
- **解析为：** 单个 SQLite 文件路径（非目录）。每个路径指向 Qoder 桌面 IDE 助手的主数据库。
- **隐私硬限制：** 摄取服务以 `readonly: true` + `fileMustExist: true` 打开 Qoder DB，绝不执行任何写 PRAGMA / INSERT / UPDATE / DELETE。不会读取 `machine_token.json`、`supabase_token` 表、`secret://` 键或任何认证/凭据存储。
- **发现语义：** `discoverQoderSources()` 验证 DB 包含 `chat_session`、`chat_record`、`chat_message` 三张表；返回 `configured`（有效）/ `empty`（无会话）/ `error`（不可读或表缺失）状态。
- **跳过缓存策略：** 按会话指纹跳过（`sha256(qoder-session-v1:<id>:<gmt_modified>:<msg_count>:<max_msg_gmt>)`），而非整个 DB 文件哈希。变更单个会话后仅重新索引该会话。
- **费用估算：** Qoder 本地数据不暴露可读的逐 session credit 消耗。摄取服务读取 root session 及其递归 subagent 的 assistant `token_info`，用本地截图校准出的 `QODER_BASE_CREDITS_PER_M_TOKENS` 乘以模型倍率估算 Credits，再用 `QODER_USD_PER_CREDIT` 折算 USD。默认校准为：基础 1.0 模型约 `45.986482` credits / 1M gross tokens，当前 Ultimate 特惠倍率 `0.8x`，即约 `36.789186` credits / 1M gross tokens；正常 Ultimate 可用 `QODER_ULTIMATE_MULTIPLIER=1.6` 覆盖。

### `WORKSPACE_PATH`（已弃用）

- **默认值：** `~/.openclaw`（去除尾部的 `/workspace` 之后）。
- **注意：** 此变量已被 `OPENCLAW_DIR` 替代。保留是为了向后兼容。如果同时设置了 `OPENCLAW_DIR`，则优先使用 `OPENCLAW_DIR`。

### 配置文件格式

`~/.agent-trail/config.json` 支持多目录扫描，格式如下：

```json
{
  "openclaw_dirs": ["/Users/<you>/.openclaw/agents"],
  "claude_project_dirs": ["/Users/<you>/.claude/projects"],
  "codex_sessions_dirs": ["/Users/<you>/.codex/sessions"],
  "opencode_db_path": "/Users/<you>/.local/share/opencode/opencode.db",
  "qoder_db_paths": ["/Users/<you>/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db"]
}
```

每个键的值为路径数组。相对路径会基于用户主目录（`~`）解析。环境变量设置时，配置文件中对应的键被忽略（环境变量优先）。

---

## 3. 摄取服务 (`ingest/config/index.ts`)

`loadConfig()` 在启动时运行，**遇到无效值会抛出异常**（服务退出）。以下默认值与 `IngestConfig` 匹配。关于每个配置项在运行时实际改变了什么，请参见 [`services/ingest.md`](services/ingest.md)。

| 变量 | 默认值 | 校验规则 | 效果 |
| --- | --- | --- | --- |
| `INGEST_PORT` | `8078` | 整数，范围 `[1024, 65535]` | Hono 服务器的 TCP 端口。 |
| `INGEST_DB_PATH` | `./data/ingest.db` | 非空；不能包含 `..`（阻止路径穿越） | 解析为绝对路径。父目录在打开时创建。 |
| `AGENT_TRAIL_LOG_LEVEL` / `INGEST_LOG_LEVEL` | 开发模式 `info`，生产/打包模式 `warn` | 取值为 `silent \| error \| warn \| info \| debug` 之一 | 控制运行时日志。npm/Docker 启动器默认缓冲子进程日志，只在失败时输出；设为 `debug` 可实时打印详细日志。旧变量 `AGENTS_TRACING_LOG_LEVEL` 仍作为兼容 fallback。 |
| `QODER_BASE_CREDITS_PER_M_TOKENS` | `45.986482` | 可解析为非负数字 | Qoder token 校准估算中，基础 1.0 模型每 1M gross tokens 对应的 credits。 |
| `QODER_ULTIMATE_MULTIPLIER` | `0.8` | 可解析为非负数字 | Ultimate 模型倍率。当前限时特惠为 `0.8`；如要按正常价估算可设为 `1.6`。 |
| `QODER_USD_PER_CREDIT` | `0.01` | 可解析为非负数字 | Qoder credit 估算值折算为 USD 时使用的单 credit 价格。 |
| `INGEST_RESYNC_INTERVAL_MS` | `900000`（15 分钟） | 整数，≥ 5000 | 文件监视器的定期目录一致性重新同步间隔。 |
| `INGEST_DEBOUNCE_MS` | `500` | 整数，≥ 100 | 文件系统事件与同步触发之间的防抖时间窗口。 |
| `INGEST_STARTUP_SYNC_LIMIT` | `50` | 整数，≥ 0 | 在 `/health` 报告 `ready: true` 之前的预热阶段中，每个数据源解析的最新文件数。设为 `0` 则完全跳过预热。 |
| `INGEST_BACKGROUND_SYNC_ENABLED` | `true` | 真值：`true \| 1 \| yes`（不区分大小写） | 为 true 时，预热后服务为每个数据源运行全量历史同步。 |
| `INGEST_PARSE_CONCURRENCY` | `1` | 整数，范围 `[1, 4]` | Phase 16 有界吞吐控制。当前默认串行解析；该值保留给后续显式并发实现，防止无界 parser fan-out。 |
| `INGEST_SQLITE_BATCH_SIZE` | `500` | 整数，范围 `[1, 5000]` | Phase 16 有界 SQLite 批量写入控制。当前 append writer 仍以事务内预处理语句循环写入。 |
| `INGEST_SYNC_HISTORY_LIMIT` | `20` | 整数，范围 `[1, 100]` | `/api/v1/debug/sync` 和 scheduler 内存 recent-run ring buffer 的最大条数。 |
| `INGEST_RATE_LIMIT_RPM` | `100` | 不可解析时回退到 `100` | 每个 IP 每分钟的请求数。 |
| `INGEST_RATE_LIMIT_ENABLED` | `true` | 真值：`true \| 1 \| yes` | 切换 `rateLimiter` 中间件。`/health` 和 `/version` 始终免限。 |
| `INGEST_DEBUG` | `false` | 真值：`true \| 1 \| yes` | 为 true 时，全局错误处理器向客户端返回实际的 `err.message` 和堆栈。**切勿在共享环境中启用** — 分享日志前关闭此选项。 |

`getConfig()` 缓存结果；`loadConfig()` 重新加载（供测试使用）。

### 无效值行为

错误值会产生致命启动错误，例如：

```text
Error: Invalid INGEST_PORT: 99 must be between 1024 and 65535
Error: Invalid INGEST_RESYNC_INTERVAL_MS: "1000" must be at least 5000ms
Error: INGEST_DB_PATH cannot contain ".." (path traversal)
```

请在启动两个服务的父 shell 中 export 它们（独立 ingest 不自动加载 `.env.local`）；如果值错误，服务会在绑定端口之前退出（`pnpm dev` 此时将只显示 `[NEXT]` 前缀继续运行）。

---

## 4. 前端 (`app/` 和 `lib/`)

| 变量 | 默认值 | 读取位置 | 用途 |
| --- | --- | --- | --- |
| `INGEST_URL` | `http://localhost:8078` | `lib/agent-tools/server-adapter.ts` (`fetchIngest`)；`app/api/agent-tools/[tool]/events/route.ts` | BFF 用于与摄取服务通信的基础 URL。仅服务端使用。 |
| `NEXT_PUBLIC_API_BASE` | _(无 — 使用时必须设置)_ | 仅在 `.env.local` 中；**源代码中当前无导入**。`CLAUDE.md` 中记录为旧版 OpenClaw 消费者所期望的 HTTP API 端点。 | 当前未被仓库内的代码路径使用；保留以与 OVAO 时代保持向后兼容。 |
| `NEXT_PUBLIC_GATEWAY_WS` | _(无 — 使用时必须设置)_ | 仅在 `.env.local` 中；**源代码中当前无导入**。`CLAUDE.md` 中记录为 OpenClaw Gateway WebSocket URL。 | 当前未被仓库源代码使用。GatewayBootstrap / WS 客户端未在当前多源前端中连接；该内容保留在 `.planning/` 历史记录中。<!-- VERIFY: 确认 NEXT_PUBLIC_GATEWAY_WS 是否被文档之外的任何部署界面需要 --> |
| `PORT` | npm/Docker `3030`；源码脚本显式 `3029` | CLI / Next.js | 源码自定义端口使用 `pnpm exec next dev --webpack --port 3031`。 |

本地设置期间生成的空 `.env.local` 通常包含以下内容：

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8000
NEXT_PUBLIC_GATEWAY_WS=ws://localhost:18789
OPENCLAW_DIR=/Users/<you>/.openclaw/agents
CLAUDE_PROJECTS_DIR=/Users/<you>/.claude/projects
CODEX_SESSIONS_DIR=/Users/<you>/.codex/sessions
OPENCODE_DB_PATH=/Users/<you>/.local/share/opencode/opencode.db
```

`OPENCLAW_DIR`、`CLAUDE_PROJECTS_DIR`、`CODEX_SESSIONS_DIR`、`OPENCODE_DB_PATH` 控制数据源发现。也可以通过 `~/.agent-trail/config.json` 配置（支持多目录），旧 `~/.agents-tracing/config.json` 仍作为 fallback。保留 `NEXT_PUBLIC_*` 变量以与旧版 OpenClaw 工具保持兼容，除非你确定本地技术栈中没有任何内容读取它们。

---

## 5. 构建时配置

| 文件 | 控制内容 |
| --- | --- |
| `next.config.ts` | 空 `NextConfig` — Next 16 默认值。代码中未设置 Turbopack 标志；`pnpm dev:next` 使用 `--webpack` 运行，因为 Turbopack 在本代码库中触发编译风暴（参见 `../ERRORS_LEARNED.md` 和 20260506-001 快速修复）。 |
| `postcss.config.mjs` | 加载 `@tailwindcss/postcss` — Tailwind v4 配合 Next 所必需。 |
| `app/globals.css` | 通过 `@theme inline { ... }` 定义主题令牌。**没有 `tailwind.config.js`** — 在这里更改颜色 / 字体 / 断点。 |
| `tsconfig.json` | `target: ES2017`，`moduleResolution: bundler`，严格模式；包含 `ingest/**/*`，以便 `@/types/trace` 等类型可在两个项目中解析。 |
| `ingest/tsconfig.json` | 摄取服务的项目引用；`tsc -p ingest/tsconfig.json` 构建到 `ingest/dist/`。 |
| `eslint.config.mjs` | 基于 `eslint-config-next` 的扁平配置；忽略 `.next/`、`out/`、`build/`、`next-env.d.ts`。 |
| `vitest.config.ts` | 包含 `tests/**/*.test.{ts,tsx}`、`lib/**/*.test.{ts,tsx}`、`ingest/**/*.test.ts`。环境默认为 `node`；组件测试显式引入 jsdom。 |
| `components.json` | shadcn 配置：`style: "radix-nova"`，`baseColor: "neutral"`，`iconLibrary: "lucide"`，组件别名 `@/components/ui`。 |
| `.gitignore` | `.env*`、`data/`、`ingest/dist/`、`.ovao-config.json`、`.local/real-session-corpus.json`、`.next/` 等。 |

---

## 6. 运行时 / 运维设置（非代码内）

以下内容未出现在源代码中，但出现在运维实践中：

- **`pnpm dev` 的颜色前缀。** `concurrently -k --names "INGEST,NEXT" --prefix-colors "green,blue"` 包装两个服务。如果终端无法渲染这些颜色，可使用 `--prefix-colors` 覆盖。
- **进程守护。** 在 `pnpm dev` 之外，生产启动方式为 `pnpm start`（Next）和 `pnpm start:ingest`（Hono）。两者均为普通 `node` 进程 — 可用 `pm2`、`systemd` 或你选择的启动器包装；两者均未内部守护化。
- **数据库持久性。** SQLite 以 WAL 模式打开（`PRAGMA journal_mode = WAL`，`synchronous = NORMAL`）。`data/ingest.db-wal` 和 `data/ingest.db-shm` 文件是正常的 — 请勿在服务运行时删除它们。先停止摄取服务。
- **重启 vs. 重置。** 删除 `data/ingest.db` 是安全的全量重置路径：服务下次启动时从头重建模式并迁移。没有迁移回滚 — 回退意味着摧毁数据库。

---

## 7. 配置故障排除

| 症状 | 可能原因 | 修复方法 |
| --- | --- | --- |
| 摄取服务在 `pnpm dev:ingest` 时立即退出 | 错误的 `INGEST_*` 值（例如不可解析的端口） | 阅读打印的 `Error:` 行；值必须满足上述校验表 |
| `/api/v1/sources` 对某个数据源显示 `error: "ENOENT: ..."` | 数据源根目录不存在 | 设置对应的 `OPENCLAW_DIR` / `CLAUDE_PROJECTS_DIR` / `CODEX_SESSIONS_DIR` / `OPENCODE_DB_PATH` 环境变量，或在 `~/.agent-trail/config.json` 中配置路径，或创建该目录 |
| OpenClaw 数据源显示 `sessionCount: 0, error: "No agent sessions found"` | `~/.openclaw/agents/<agent>/sessions/` 为空 | 运行一个 OpenClaw 会话来创建一些内容，或将 `OPENCLAW_DIR` 指向已有会话的目录 |
| `[sources] Rejected path outside root: ...` 警告 | 符号链接离开了配置的根目录，或发现了奇怪的绝对路径 | 修复符号链接；`isWithinRoot` 是刻意的限制且不可配置 |
| BFF 返回 502 `Ingest service unreachable` | 摄取服务崩溃或 `INGEST_URL` 错误 | 检查 `pnpm dev` 日志；`curl http://localhost:8078/health`；重新设置 `INGEST_URL` |
| BFF 返回 400 `Invalid source tool ID` | URL `[tool]` 段错误 | 使用 `openclaw`、`claude-code`、`codex` 或 `opencode`（注意连字符）。`all` 仅在 shell 层工作，BFF 层不行。 |
| 健康覆盖层永远停留在 "检查中" | 摄取服务已启动但 `INGEST_STARTUP_SYNC_LIMIT` 很大，预热尚未完成 | 降低限制值或设为 `0` 跳过预热；全量同步仍在后台运行 |

关于"我修改了解析器但数据库显示过时数据"的问题，请参阅 [`services/ingest.md`](services/ingest.md) 中的跳过缓存章节：升级 `PARSER_CACHE_VERSION` 或使用 `{"force": true}` 调用 `POST /api/v1/sources/:type/sync`。
