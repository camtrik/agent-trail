# 架构

agent-trail 是一个**双进程本地应用**：一个 Hono 摄取服务，监视本地 JSONL 会话文件并将其索引到 SQLite；一个 Next.js 前端，通过轻量 BFF（backend-for-frontend）代理消费这些数据。本文档说明系统布局、服务之间的边界，以及维系它们的关键不变量。

关于端到端数据流转（文件 → 数据库 → UI），请参阅 [`DATA-FLOW.md`](DATA-FLOW.md)。关于 SQLite 契约，请参阅 [`db-schema.md`](db-schema.md)。关于每个服务的实现细节，请参阅 [`services/ingest.md`](services/ingest.md) 和 [`services/frontend.md`](services/frontend.md)。

---

## 1. 系统概览

```text
┌──────────────────────────────────────── developer's machine ─────────────────────────────────────────┐
│                                                                                                       │
│   On-disk session sources                                                                             │
│   ────────────────────────                                                                            │
│   ~/.openclaw/agents/{name}/sessions/*.jsonl                                                          │
│   ~/.claude/projects/{encoded-cwd}/{uuid}.jsonl                                                       │
│   ~/.codex/sessions/**/*.jsonl                                                                        │
│                                                       │                                               │
│                          (chokidar watch + 15-min consistency resync)                                 │
│                                                       ▼                                               │
│   ┌───────────────────────────  Ingest service (Hono on :8078) ────────────────────────────────┐    │
│   │                                                                                              │    │
│   │   discovery → parser → sync (skip cache + transactional write) → SQLite (data/ingest.db)    │    │
│   │                                                                  │                           │    │
│   │   REST  : /api/v1/sources, /sessions, /sessions/:id, /turns, /messages, /lookup            │    │
│   │   SSE   : /api/v1/events, /api/v1/sessions/:id/events                                       │    │
│   │   Health: /health, /version                                                                  │    │
│   └───────────────────────────────────────────┬───────────────────────────────────────────────┘    │
│                                               │ HTTP / SSE (only on localhost)                       │
│   ┌───────────────────────────  Next.js frontend (port :3029) ───────────────────────────────┐     │
│   │                                                                                            │     │
│   │   BFF proxy (D-07): app/api/agent-tools/[tool]/{health,sessions,sync,events,...}          │     │
│   │     - validates [tool] (assertSourceToolId)                                                │     │
│   │     - injects source=[tool] into ingest queries                                            │     │
│   │     - caps limit at 100                                                                    │     │
│   │     - sanitizes errors (502 generic message)                                               │     │
│   │                                                                                            │     │
│   │   Shell + per-tool pages: app/(tool-shell)/[tool]/{dashboard,sessions,activity}           │     │
│   │   Replay UI: components/replay/* (turn timeline, tool/skill/subagent/system blocks)        │     │
│   │   Zustand stores: stores/{ui,replay,tool,theme,ingest-health,office-layout}                │     │
│   └────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                       │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

两个服务均为**普通 Node.js 进程**，由 `pnpm dev` 通过 `concurrently` 启动。没有容器，没有消息总线，没有外部数据库。

---

## 2. 为什么是双服务？

这种分离是刻意的且具有结构意义。

| 考量维度 | 前端 (Next.js) | 摄取服务 (Hono) |
| --- | --- | --- |
| **重启成本** | 慢（完整 Next 编译） | 快（`tsx watch`） |
| **进程模型** | 按请求处理的处理器 | 长生命周期：文件监视器、SSE 订阅者、预编译语句 |
| **热重载行为** | 重新渲染 React 树 | 重新建立文件监视器 + 数据库连接 |
| **依赖** | React、Tailwind、shadcn | better-sqlite3（原生模块）、chokidar |
| **故障模式** | UI 过时，可恢复 | 停止索引 — 但 UI 通过 ingest-health 覆盖层优雅降级 |

如果前端直接导入解析器和监视器，每次 UI 热重载都会拆除 chokidar 监视器并强制进行全量重新扫描。分离可以使摄取服务在 UI 变动期间保持稳定，并将 better-sqlite3（原生模块）与 Next 的打包器隔离。

---

## 3. 服务边界

### 3.1 BFF 代理是前端到摄取服务的唯一路径 (D-07)

前端**绝不**直接调用摄取服务。每个请求都通过 `app/api/agent-tools/[tool]/...` 流转。这是一条硬性规则，由代码审查强制执行，并在 [`lib/agent-tools/server-adapter.ts`](../lib/agent-tools/server-adapter.ts) 中明确说明。

BFF 为我们免费提供了四个属性：

1. **源范围限定。** URL 中的 `[tool]` 段是信任边界。`assertSourceToolId(tool)` 拒绝任何不是 `openclaw`、`claude-code` 或 `codex` 的值并返回 400。适配器随后将 `source=<tool>` 注入摄取查询 — 调用者提供的 `source` 被有意忽略（`buildSourceScopedSessionParams` 会删除它）。
2. **跨源隔离。** `getSourceScopedSession` 读取会话，在返回任何内容之前校验 `session.source === source`；子资源（`/messages`、`/turns`）首先调用 `requireSourceScopedSession`，因此 Codex 客户端无法通过猜测 ID 获取 OpenClaw 会话。
3. **上限限制。** 即使摄取服务允许最多 1000，BFF 仍将 `limit` 上限设为 100。UI 列表永远不需要超过此值，我们不希望浏览器标签页分配数 MB 的 JSON 数据块。
4. **错误清理。** `sanitizeError` 在响应前会剥离堆栈跟踪、内部路径和摄取服务内部信息。任何我们无法分类的内容都会变成 `{ error: "Ingest service unreachable", code: 502 }`。校验错误保留其 HTTP 状态码（400 / 404）。

`/api/agent-tools/[tool]/events` 是 SSE 透传路由。它向摄取服务端的 `/api/v1/events`（或 `/api/v1/sessions/:id/events`）发起 `fetch` 并将响应体直接管道传输到浏览器，设置 `runtime = 'nodejs'` 和 `dynamic = 'force-dynamic'`，确保 Next 不会试图缓存或缓冲该流。

### 3.2 按工具路由 (D-08)

所有已注册来源共享同一个 shell（`app/(tool-shell)/[tool]/`）和同一个 BFF 分发表：

```ts
const adapters: Record<string, AgentToolServerAdapter> = {
  all: allAdapter,           // 跨源，不做 source 过滤
  openclaw: openclawAdapter,
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  qoder: qoderAdapter,
  commandcode: commandcodeAdapter,
}
```

适配器是纯粹的分发器 — 路由处理器中没有 `if (toolId === 'openclaw')` 分支。BFF 中唯一按工具区分的代码是位于 `/api/agent-tools/[tool]/sessions/lookup` 的 OpenClaw 专属 Gateway 查找（依据 D-10）。

聚合作用域 `all` 是合成的聚合视图。它有自己的 adapter（`allAdapter`），直接调 ingest API 不做 source 过滤，支持在 ALL 模式下查看任意 session 的详情、turns 和 messages。`assertSourceToolId` 仍拒绝 `all`；BFF route 在 `tool === 'all'` 时直接使用 `allAdapter` 而不经过 `assertSourceToolId`。

### 3.3 信任边界总结

| 边界 | 校验器 | 响应 |
| --- | --- | --- |
| `[tool]` URL 段 (BFF) | `assertSourceToolId`（shell 使用 `assertAgentToolId`） | 未知工具返回 400 |
| `sessionId` URL 段 (BFF) | `validateSessionId`（正则 `^[a-zA-Z0-9:\-_.]{1,256}$`） | 格式错误返回 400 |
| `sessionId` URL 段 (摄取服务) | 独立应用相同的正则 | 格式错误返回 400 |
| `?source=` (摄取服务) | 白名单 `['openclaw', 'claude-code', 'codex', 'opencode', 'qoder', 'commandcode']` | 未知源返回 400 |
| `?role=` (摄取服务 `/messages`) | 白名单 `['user', 'assistant', 'system', 'tool_result']` | 错误 role 返回 400 |
| `?sort=` / `?order=` (摄取服务) | 白名单 `updated_at` / `started_at` / `ended_at` × `asc` / `desc` | 错误排序返回 400 |
| `limit` / `offset` | 非负整数；`limit` 上限 1000（摄取服务）/ 100 (BFF) | 负数返回 400 |
| 源路径发现 | `isWithinRoot`（解析后的绝对路径） | 路径被过滤掉并输出警告 |

---

## 4. 规范追踪契约

系统中的一切均使用同一数据结构，定义在 [`types/trace.ts`](../types/trace.ts) 中：

```text
TraceSource           = 'openclaw' | 'claude-code' | 'codex' | 'opencode' | 'qoder' | 'commandcode'
TraceSession          { id, source, project, name?, startedAt, endedAt, status, metrics, ... }
TraceTurn             { id, sessionId, index, userMessage, assistantMessages[], activities[], ... }
TraceMessage          { id, ordinal, role, content, timestamp?, model?, tokenUsage?, sourceMetadata }
TraceActivity         = TraceToolCall | TraceSkillUse | TraceSubagentLink | TraceThinkingBlock | TraceSystemEvent
TraceToolCall         { id, name, category, inputJson, status, resultEvents[], durationMs?, messageOrdinal? }
```

**为什么采用以轮次为先的模型？** 轮次是用户的心智单元（"一轮提问并获得一次回复"）。原始消息会迫使 UI 每次渲染都进行分组。轮次组装器在每次会话视图中按需运行一次。

该契约被以下组件消费：

- 解析器 — 它们输出 `ParseResult { session, messages[], activities[], errors[] }`（参见 [`ingest/parser/types.ts`](../ingest/parser/types.ts)）。
- 同步层 — 将契约写入 SQLite（关于表映射，参见 [`db-schema.md`](db-schema.md)）。
- 轮次组装器 — 读取 `messages` 和 `tool_calls` 行，在查询时生成 `TraceTurn[]`。
- BFF + UI — BFF 返回的 JSON 正是规范结构；React 中无需重新映射。

数据源特定的结构体留在解析器中；下游所有内容仅看到规范模型。

---

## 5. 读取模型：为什么是 SQLite，为什么按需组装轮次

JSONL 文件适合 AI 工具写入，但不适合 UI 读取：

- 过滤"所有涉及项目 X 的会话，按时间排序"需要读取每个文件。
- 跨数百个会话的分页需要每次都进行内存排序。
- 子代理关系跨越多个文件。

因此我们在 `data/ingest.db`（SQLite，WAL 模式）中构建了一个**读取模型**：

- `sessions` — 每个会话文件一行，按 `(source, project)`、`started_at`、子代理的 parent / root 进行索引。
- `messages` — 每个会话的扁平有序消息，主键查找为 `(session_id, ordinal)`。
- `tool_calls` + `tool_result_events` — 与消息关联的工具调用。
- `turns` — 可预计算的轮次行（当前始终在读取时从消息重新组装；该表存在是为将来的缓存做准备）。
- `sync_status` — 每个数据源的最后同步时间 + 错误。

完整模式文档参见 [`db-schema.md`](db-schema.md)。

**轮次组装在读时进行，而非写时。** 每次调用 `GET /api/v1/sessions/:id/turns` 都会运行 `assembleTurns(sessionId)`：

1. `SELECT messages WHERE session_id ORDER BY ordinal`（一次查询）。
2. 遍历消息，在每个用户消息处开启一个新轮次，累积助手 + tool_result 消息，当 `[compact]` 系统事件着陆时标记轮次被截断 (D-10)，并将连续的用户消息合并为排队命令 (D-05)。
3. JOIN `tool_calls` + `tool_result_events` 并附加到相应的轮次。
4. JOIN 子会话 `WHERE parent_session_id = ?` 以将子代理链接添加到第一个轮次。

这使写入路径保持简单（解析器无需输出轮次边界），并让我们可以在不重写索引数据的情况下演进组装器。

---

## 6. 同步管道概览

摄取服务的 `index.ts` 按以下顺序启动：

1. `loadConfig()` — 解析 `INGEST_*` 环境变量并进行严格校验。
2. `openDatabase()` + `initSchema()` — 打开 `data/ingest.db`，运行 `schema.sql`，然后执行 `runMigrations()`（使用 `PRAGMA user_version`，目标版本为 6）。
3. `serve(app)` 在 `INGEST_PORT` 上 — HTTP 立即启动，以便 `/health` 可响应（此时 `ready: false`）。
4. `initializeSourcesAndSync()`（后台）：发现数据源 → 创建 `chokidar` 监视器 → 运行**有限预热同步**（每个源最新的 `INGEST_STARTUP_SYNC_LIMIT` 个文件，默认 50） → 启动 watcher → 切换 `ready: true` → 如果 `INGEST_BACKGROUND_SYNC_ENABLED` 为 true，则为每个数据源通过 scheduler 运行全量一致性同步。

这种分离 — TCP 立即开启，索引在后台进行 — 是在快速任务 260509-nwg 中添加的，目的是不让前端被数千个文件的历史扫描阻塞。

监视器对文件事件进行防抖处理（`INGEST_DEBOUNCE_MS`，默认 500ms），并回退到定期目录一致性重新同步（`INGEST_RESYNC_INTERVAL_MS`，默认 15 分钟）。文件变更时通过 scheduler 调用 path-scoped sync；周期或手动刷新时调用 full-source consistency sync，该函数：

1. 重新发现源目录（开销小，只是 `fs.readdir`）。
2. 列出候选 `.jsonl` 文件（如果设置了限制则按 mtime 排序）。
3. 对每个文件：先对照 `sessions.file_size` / `file_mtime` / parser cache version 做 parser 前跳过；需要解析时再走 append cursor 或完整 parse，并对会话及其派生行进行事务性写入。
4. 发送 SSE：每个文件 `session_created` / `session_updated`，每个数据源 `sync_complete`。
5. upsert `sync_status`。

跳过缓存的键是 `parser-v11-qoder-token-calibrated-cost:<source>:<sha256>`，因此升级解析器缓存版本会强制在下次同步时全局重新解析 — 这在解析器输出结构发生变化时使用。

监视器和同步的内部细节详见 [`services/ingest.md`](services/ingest.md)。完整的响应式更新路径（文件变更 → SSE → UI 重新获取）见 [`DATA-FLOW.md`](DATA-FLOW.md)。

---

## 7. 前端布局

路由位于 `app/(tool-shell)/[tool]/` 下（一个路由组，因此 `(tool-shell)` 不是 URL 的一部分）。`[tool]` 取值为 `openclaw | claude-code | codex | all`。根路由 `app/page.tsx` 将 `/` 重定向到 `/all/dashboard`。

Shell（`components/shell/shell-frame.tsx`）是一个 3 行 CSS 网格：48px 头部，1fr 主区域（可选 360px 右侧栏），26px 状态栏。`SidebarNav` 是一个固定的 56px 列；`SourceSwitcher` 位于头部。

每个工具的行为由 `lib/agent-tools/{openclaw,claude-code,codex,all}/definition.ts` 中的 `AgentToolDefinition` 记录驱动。注册表暴露：

- `capabilities` — 功能开关（sessions、replay、activity、subagents、cost 等），用于控制导航项和页面。
- `nav` — 侧栏项，每个项带有可选的 `requiredCapability` 标志。
- `ui` — 品牌标签、会话表格列定义、可选仪表盘插槽、可选格式化器。

`AgentToolProvider`（`lib/agent-tools/client-hooks.tsx`）用解析后的定义包装组件树。页面调用 `useAgentTool()` 获取当前的 `toolId` 和一个 `href(route)` 构建器，该构建器会添加 `/<tool>` 前缀。数据钩子（`useSessionDetail`、`useSessionTurns` 等）访问 BFF，绝不访问摄取服务。

状态管理被有意拆分：

| 存储 | 用途 |
| --- | --- |
| `tool-store` | 当前选中的会话、侧栏状态 |
| `replay-store` | 每个轮次的展开/折叠、搜索查询、展开的块 |
| `ui-store` | 右侧栏开关、模态框状态 |
| `ingest-health-store` | 来自 `/api/ingest/health` 轮询的 `'checking' \| 'connected' \| 'timeout'` |
| `theme-store` | 浅色 / 深色 / 跟随系统（带有 `app/layout.tsx` 中的同步引导脚本） |
| `office-layout/` | OpenClaw 2D 办公平面图持久化 |

更深入的组件逐一介绍见 [`services/frontend.md`](services/frontend.md)。

---

## 8. 实时失效

前端将 SSE 事件视为**失效信号**，而非数据更新（规划文档中的 D-12）。当 `session_updated` 触发时，相关的 React 钩子会重新获取会话详情；SSE 负载本身只是告诉我们*要重新获取什么*。

```text
ingest writeSessionToDatabase()
  └─ commit transaction
  └─ sseManager.emit('session_updated', {sessionId, source})
  └─ sseManager.emitSessionEvent(sessionId, 'session_updated', {})

BFF /api/agent-tools/openclaw/events
  └─ proxies SSE body straight to browser EventSource

useSessionTurns(toolId, sessionId, ...)
  └─ subscribes to /api/agent-tools/<tool>/events?sessionId=<id>
  └─ on session_updated → refetch
```

这避免了两种故障模式：(1) 通过 SSE 传输可能较大的轮次负载，以及 (2) 试图在客户端增量合并轮次组装结果。下一次获取返回规范的、最新的状态。

---

## 9. 配置概览

所有配置项均为环境变量 — 项目刻意**没有 `.env.example`** 需要提交，但 [`CONFIGURATION.md`](CONFIGURATION.md) 列出了每个变量及其默认值和校验规则。几乎总是需要关注的变量：

| 变量 | 默认值 | 为什么需要关注 |
| --- | --- | --- |
| `OPENCLAW_DIR` | `~/.openclaw/agents` | OpenClaw 源目录（可配置多个，见下文） |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Claude Code 源目录 |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex 源目录 |
| `AGENT_TRAIL_CONFIG` | `~/.agent-trail/config.json` | 配置文件路径（可在其中定义多目录；旧 `AGENTS_TRACING_CONFIG` 仍兼容） |
| `INGEST_PORT` | `8078` | Hono 端口 |
| `INGEST_DB_PATH` | `./data/ingest.db` | SQLite 文件（阻止路径穿越） |
| `INGEST_STARTUP_SYNC_LIMIT` | `50` | 每个数据源在 `ready: true` 之前索引的最新文件数 |
| `INGEST_BACKGROUND_SYNC_ENABLED` | `true` | 预热后是否进行全量历史扫描 |

**工具目录注册表**（`ingest/config/tool-dirs.ts`）集中管理每个数据源的扫描目录。目录解析优先级：环境变量 > 配置文件（`~/.agent-trail/config.json`，并兼容旧 `~/.agents-tracing/config.json`）> 内置默认值。配置文件中可指定多个目录（数组），环境变量仅支持单个目录。

前端环境变量 (`NEXT_PUBLIC_*`) 存放在 `.env.local`（gitignore 中）。

---

## 10. 关键决策（规范）

这些是编码到代码库中的重要决策。编号 ID 与 `.planning/` 引用相匹配。

| ID | 决策 | 原因 |
| --- | --- | --- |
| **D-07** | BFF 代理是前端到摄取服务的唯一路径 | 单一的源范围限定与错误清理点 |
| **D-08** | 统一的按工具路由（一个 shell，一个路由表） | 避免每个数据源的仪表盘分化 |
| **D-10** | Compact / system 事件存储为轮次活动 | 在不丢失信息的情况下在回放中显示边界 |
| **D-11** | 轮次组装器在读时配对工具调用和链接子代理 | 保持解析器简单；自由演进视图层 |
| **D-12** | SSE = 仅用于失效，绝不内联数据 | 限制负载大小；幂等刷新 |
| **D-14** | 数据源拥有独立的 `ingestStatus` + `gatewayStatus` | OpenClaw 有 Gateway；Claude/Codex 没有 |
| **D-21** | 仅枚举数据源类型 — 没有通用解析器回退 | 特定源的日志格式需要特定源的解析器 |
| Skip cache | 当 `sha256(file) == sessions.file_hash` 时跳过解析（带版本的键） | 幂等重新同步；升级版本强制全局重新解析 |
| Read-only | 仪表盘从不执行工具或修改会话文件 | 安全性 + 明确的产品范围 (v1) |
| Local-first | 无云端，无遥测，路径限制在配置的根目录内 | 会话可能包含代码、路径、密钥 |

关于决策历史与理由，请参阅 [`.planning/PROJECT.md`](../.planning/PROJECT.md) 以及每个阶段的 `CONTEXT.md` 文件。

---

## 11. 本架构刻意不做的事情

- **没有遥测 / OTLP 采集器。** 这是一个会话查看器，而非可观察性平台。
- **没有工具重新执行 / 带变更的回放。** 回放仅观察；绝不重新运行。
- **没有多用户支持，没有认证，没有 RBAC。** 单用户本地工具。
- **没有提示词试验场、模型比较、LLM 法官。** 根据 `.planning/PROJECT.md`，超出 v1 范围。
- **没有公开分享链接，没有上传功能。** 会话可能泄露凭据和代码。
- **没有 agentsview 风格的通用代理注册表。** 支持范围由枚举注册表与各来源适配器决定，具体格式及限制见 [COMPATIBILITY.md](COMPATIBILITY.md) (D-21)。

有疑问时以以下原则为准：**只读、仅本地、来源隔离**。
