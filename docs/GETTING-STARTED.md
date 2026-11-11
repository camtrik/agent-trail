# 快速开始

本指南将带你从克隆代码到运行一个可用的仪表盘，并至少索引一个数据源。如果你的磁盘上已有 OpenClaw、Claude Code 或 Codex 的会话记录，预计大约 5 分钟；如果需要先安装 Node 和 pnpm，则大约需要 15 分钟。

> 架构上下文：[`ARCHITECTURE.md`](ARCHITECTURE.md)。所有配置项参见 [`CONFIGURATION.md`](CONFIGURATION.md)。安装完成后的日常工作流程参见 [`DEVELOPMENT.md`](DEVELOPMENT.md)。

---

## 1. 前置条件

- **推荐 Node.js 24。** 开发、CI 与 Docker 使用 Node 24 验证；没有匹配的 SQLite 预构建包时需要 C/C++ 编译器。
- **pnpm 11.1.3。** 请使用 pnpm——`pnpm-lock.yaml` 是唯一的依赖锁定文件。在全新机器上可以运行 `corepack enable && corepack prepare pnpm@11.1.3 --activate`。
- **一个支持原生 `better-sqlite3` 的平台。** macOS（arm64/x64）、Linux 和 Windows 都有预构建包。如果 `pnpm install` 从源码重新构建它，你需要一个可用的 C/C++ 工具链。
- **至少一个数据源目录**（否则仪表盘会以空的 source 列表加载）：
  - OpenClaw：`~/.openclaw/agents/<agent-name>/sessions/*.jsonl` 目录树（或通过 `OPENCLAW_DIR` 指向你自己的路径）。
  - Claude Code：`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`（当你运行会话时，Claude Code 会自动创建这些文件）。
  - Codex：`~/.codex/sessions/*.jsonl`。

不需要拥有全部数据源，完整格式与限制见 [COMPATIBILITY.md](COMPATIBILITY.md)。仪表盘只会显示它能够找到的 source。

---

## 2. 安装

```bash
git clone <your-repo-url> agent-trail
cd agent-trail
pnpm install
```

`pnpm install` 会编译/获取 `better-sqlite3` 的预构建包——这是最慢的一步。

---

## 3. 配置

工具目录通过三层配置解析（优先级从高到低）：**环境变量** > **配置文件** > **内置默认值**。

### 方式一：环境变量（父进程 shell）

在启动两个服务的 shell 中 export 配置。只有 Next.js 自动读取 `.env.local`，ingest 不会自动加载它：

```bash
# Shell — 仅设置你实际需要的行

# OpenClaw — 仅当你的 OpenClaw 根目录不是 ~/.openclaw 时才需要
# export OPENCLAW_DIR=/path/to/openclaw/agents

# Claude Code — 仅当 Claude 将会话保存到 ~/.claude/projects 以外的位置时才需要
# export CLAUDE_PROJECTS_DIR=/path/to/claude/projects

# Codex — 仅当 Codex 将会话保存到 ~/.codex/sessions 以外的位置时才需要
# export CODEX_SESSIONS_DIR=/path/to/codex/sessions

# 可选的 ingest 调优参数（默认值通常就够用了）
# export INGEST_PORT=8078
# export INGEST_DB_PATH=./data/ingest.db
# export INGEST_STARTUP_SYNC_LIMIT=50
# export INGEST_BACKGROUND_SYNC_ENABLED=true
```

### 方式二：配置文件（`~/.agent-trail/config.json`）

如果不想在项目中创建 `.env.local`，也可以使用全局配置文件：

```json
{
  "openclaw_dirs": ["/path/to/openclaw/agents"],
  "claude_project_dirs": ["/path/to/claude/projects"],
  "codex_sessions_dirs": ["/path/to/codex/sessions"]
}
```

配置文件路径可通过 `AGENT_TRAIL_CONFIG` 环境变量自定义。旧变量 `AGENTS_TRACING_CONFIG` 仍作为兼容 fallback。配置值支持多个目录（数组形式）和相对路径（相对于 `$HOME`）。

完整的变量列表、默认值及验证规则见 [`CONFIGURATION.md`](CONFIGURATION.md)。

`.env.local` 已被 git 忽略；不要提交它。

---

## 4. 启动两个服务

```bash
pnpm dev
```

`concurrently` 会同时启动两个服务：

- `[INGEST]`（绿色）——Hono 运行在端口 8078
- `[NEXT]`（蓝色）——Next.js 运行在端口 3029（使用 `--webpack` 启动，而非 Turbopack）

你应该会看到类似以下的输出：

```text
[INGEST] Configuration loaded: { port: 8078, dbPath: '/.../data/ingest.db', ... }
[INGEST] Opening database: /.../data/ingest.db
[INGEST] Initializing database schema...
[INGEST] WAL mode enabled
[INGEST] Verified 6 tables created: sessions, messages, tool_calls, tool_result_events, turns, sync_status
[INGEST] Ingest service listening on port 8078
[INGEST] Discovering source directories...
[INGEST] Starting file watcher...
[INGEST] Running startup warmup sync: latest 50 files per source...
[INGEST]   Warmup sync openclaw: +12 new, ~3 updated
[INGEST]   Warmup sync claude-code: +50 new, ~0 updated
[INGEST]   Warmup sync codex: +0 new, ~0 updated
[NEXT]    ▲ Next.js 16.4.6 (webpack)
[NEXT]    - Local: http://localhost:3029
[NEXT]    ✓ Ready in 2.4s
```

按一次 `Ctrl+C` 即可停止两个服务。

如果只有 `[NEXT]` 在持续输出而 `[INGEST]` 已退出，几乎可以肯定是某个 `INGEST_*` 值有误——请参见 [`CONFIGURATION.md`](CONFIGURATION.md#7-configuration-troubleshooting) 中的故障排除表格。

---

## 5. 验证

在另一个终端中运行：

```bash
# 1. 前端可访问（会重定向 /，使用 -L 跟随重定向）
curl -I http://localhost:3029

# 2. Ingest 健康检查——预热完成后，"ready" 会变为 true
curl http://localhost:8078/health
# → {"status":"ok","ready":true,"version":"0.1.1","uptime":12.3,"database":"connected","sync":{...}}

# 3. 已发现的 source
curl http://localhost:8078/api/v1/sources
# → {"sources":[{"type":"openclaw","path":"...","sessionCount":42,"healthStatus":"configured", ...}, ...]}

# 4. 通过 BFF 获取单个 source 的会话（无需 source= ——URL 段已提供该信息）
curl 'http://localhost:3029/api/agent-tools/claude-code/sessions?limit=3'
```

在浏览器中打开 `http://localhost:3029`。你将被重定向到 `/all/dashboard`（聚合视图）。底部状态栏应显示 `INGEST · ONLINE`。

顶部有一个 source 切换器——点击 `OPENCLAW`、`CLAUDE:CODE` 或 `CODEX` 可将 shell 限定到单个 tool。每个 tool 都有自己独立的仪表盘、会话列表以及（OpenClaw 专属的）活动视图。点击某个会话会打开 `/[tool]/sessions/[sessionId]` 下的逐轮回放界面。

---

## 6. 实际运行的内容

```text
data/ingest.db          ← SQLite 读取模型（已 gitignore）。安全删除后可重新同步。
data/ingest.db-wal      ← 预写日志。不要在 ingest 运行时删除。
data/ingest.db-shm      ← 共享内存文件。同上。
.next/                  ← Next 开发产物。
ingest/dist/            ← ingest 的生产构建（仅在 pnpm build:ingest 后生成）。
```

两个服务是独立的进程，通过 `localhost:8078` ↔ `localhost:3029` 上的 HTTP + SSE 连接。前端从不直接访问数据库。每次 UI 数据获取都经过 BFF（`app/api/agent-tools/[tool]/...`）。

关于从 URL 到 React 的完整请求路径，请参见 [`DATA-FLOW.md`](DATA-FLOW.md)。关于各服务的详细拆解，请参见 [`services/ingest.md`](services/ingest.md) 和 [`services/frontend.md`](services/frontend.md)。

---

## 7. 首次运行故障排除

| 现象 | 可能原因 | 解决方法 |
| --- | --- | --- |
| `Port 3029 already in use` | 另一个开发服务器在运行 | `lsof -ti:3029 \| xargs kill` 或运行 `pnpm exec next dev --webpack --port 3031` |
| `Port 8078 already in use` | 上一次会话残留的 ingest 进程 | `lsof -ti:8078 \| xargs kill`，或设置 `INGEST_PORT=8079` |
| 状态栏显示"INGEST OFFLINE" | Ingest 崩溃或未启动 | 检查 `[INGEST]` 行的堆栈跟踪；使用 `pnpm dev:ingest` 重启 |
| OpenClaw 会话列表为空 | `OPENCLAW_DIR` 设置错误，或 `~/.openclaw/agents/*/sessions/` 为空 | 通过 `curl http://localhost:8078/api/v1/sources/openclaw` 验证；响应中的 `path` 字段即为 discoverer 正在检查的路径。可通过环境变量或 `~/.agent-trail/config.json` 自定义路径 |
| Claude Code 会话列表为空 | Claude 将会话保存在其他位置（或尚未运行过） | `ls ~/.claude/projects/` 应显示包含 `.jsonl` 文件的项目目录；如果没有，说明 Claude Code 尚无会话记录 |
| 拉取代码后出现类型错误 | 前端和 ingest 共享 `types/trace.ts`——旧构建缓存 | `pnpm typecheck` 确认；如果构建信息文件误导，删除 `tsconfig.tsbuildinfo` |
| `pnpm dev:next` 导致编译风暴 / CPU 100% | 不要切换到 Turbopack——保持 `--webpack` 参数 | 上下文信息见 `../ERRORS_LEARNED.md` |
| 已知有内容的会话在回放中显示"NO TURNS" | 文件哈希匹配但解析器缓存版本已过时 | 递增 `ingest/sync/index.ts` 中的 `PARSER_CACHE_VERSION`，重启并重新同步；或运行 `curl -X POST http://localhost:3029/api/agent-tools/<tool>/sync -H 'content-type: application/json' -d '{"force":true}'` |

---

## 8. 接下来

- 日常工作流程（热重载、调试、规范）：[`DEVELOPMENT.md`](DEVELOPMENT.md)
- 运行测试套件：[`TESTING.md`](TESTING.md)
- API 参考（所有端点）：[`API.md`](API.md)
- 数据库 schema：[`db-schema.md`](db-schema.md)
