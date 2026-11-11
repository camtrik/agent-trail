@AGENTS.md

# agent-trail

**Multi-source AI agent session tracing dashboard for OpenClaw, Claude Code, Codex, OpenCode, Qoder, and Command Code**

赛博朋克 HUD 风格的 multi-source AI agent session tracing dashboard。支持 OpenClaw、Claude Code、Codex、OpenCode、Qoder、Command Code 六个数据来源，提供 session browsing、turn replay 和 activity 追踪。

**Note**: This project was formerly known as OVAO (OpenClaw Visual Agents Office) during initial development.

## Commands

```bash
pnpm dev      # 开发服务器 (http://localhost:3029)
pnpm build    # 生产构建
pnpm start    # 启动生产服务器
pnpm lint     # ESLint (eslint-config-next)
```

包管理器是 **pnpm**（见 `pnpm-workspace.yaml`、`pnpm-lock.yaml`），不要用 npm/yarn。

## Tech Stack

- **Next.js 16.4.6** App Router + **React 19.3.1** + TypeScript
- **Tailwind v4** —— CSS-first 配置，主题在 `app/globals.css` 的 `@theme inline` 中，**没有** `tailwind.config.js`
- **shadcn/ui** —— `radix-nova` style, OKLCH 颜色, 基础色 `neutral`, lucide 图标（见 `components.json`）
- **Zustand** 状态管理
- ESLint 9（flat config in `eslint.config.mjs`）

## Architecture

双服务架构：Next.js 前端（port 3029）+ Hono ingest 服务（port 8078），前端通过 BFF 代理访问 ingest，不直连。

```text
app/
  (tool-shell)/[tool]/  # 路由组 — 按 agent tool 隔离的 Shell 布局
    dashboard/          #   Agent Dashboard
    sessions/           #   Sessions 列表 + 详情 + turn replay
    activity/           #   Activity 视图
  api/                  # BFF 代理路由 (agent-tools/[tool]/...)
  globals.css           # Tailwind v4 + 主题 token (@theme inline)
  layout.tsx            # Root layout
ingest/                 # Hono 独立服务（port 8078）
  api/                  #   REST + SSE 端点
  config/               #   环境变量配置 + tool-dirs 目录注册表
  db/                   #   SQLite (better-sqlite3, WAL)
  parser/               #   JSONL 解析器 (claude/openclaw/codex)
  src/                  #   文件监听 + SSE 管理
  sync/                 #   同步编排 + skip cache
  turns/                #   Turn 组装器
stores/                 # Zustand 前端状态
lib/agent-tools/        # Agent tool 注册表 + server/client adapter
components/ui/          # shadcn 组件 (radix-nova preset)
types/                  # 共享类型 (trace.ts 等)
.planning/              # GSD 工作流文档
```

详细架构说明 → [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

路径别名：`@/*` → `./*`（见 `tsconfig.json`）。例：`@/lib/utils`、`@/components/ui/button`。

## Conventions

- **语言**：AI 文档/spec/plan 用**中文**；代码注释、变量名、commit message 用**英文**
- **视觉令牌**：用语义化 token（`bg-background`, `text-foreground`, `border-border`），不要硬编码颜色值
- **双主题**：light/dark 都要验证，WCAG AA 对比度
- **Multi-source 架构**：支持 OpenClaw、Claude Code、Codex、OpenCode、Qoder、Command Code 六个数据来源，通过 source switcher 切换
- 遵从代码范式：实现相似功能时先看有没有已经存在的类似代码。并且参考。

## Environment

环境变量详见 [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)。关键项：

- `INGEST_PORT` — Ingest 服务端口（默认 `8078`）
- `OPENCLAW_DIR` — OpenClaw 根目录（默认 `~/.openclaw/agents`）
- `CLAUDE_PROJECTS_DIR` — Claude Code 项目目录（默认 `~/.claude/projects`）
- `CODEX_SESSIONS_DIR` — Codex 会话目录（默认 `~/.codex/sessions`）
- `AGENT_TRAIL_CONFIG` — 自定义配置文件路径（默认 `~/.agent-trail/config.json`）

工具目录解析逻辑：环境变量 > `~/.agent-trail/config.json`（兼容旧 `~/.agents-tracing/config.json`）> 内置默认值。详见 `ingest/config/tool-dirs.ts`。

## Rules (Important)

- **历史错误教训** → 见 [`ERRORS_LEARNED.md`](ERRORS_LEARNED.md)，写新组件前查阅避免重复踩坑。
- **`(tool-shell)` 是路由组**，`[tool]` 是动态段 —— URL 是 `/claude-code/dashboard`，不是 `/(tool-shell)/claude-code/dashboard`。
- **shadcn 添加组件**：`pnpm dlx shadcn@latest add <name>`，组件落在 `components/ui/`。preset 是 `radix-nova`，不要换成默认。
- **BFF 代理**：前端不直连 ingest，所有请求走 `app/api/agent-tools/[tool]/...`（D-07）。
- **GSD 工作流**：项目用 `.planning/` 跟踪 milestone/phase/plan。开新工作前看 `.planning/STATE.md` 了解当前 phase。不要手编 `.planning/` 里的 STATE/ROADMAP —— 用 `/gsd-*` 命令。
- **清理废弃代码**：修改代码时发现不再被任何地方引用的组件、函数、类型、文件，且判断未来也不太可能被使用，应当删除而不是留在代码库中。
- **多语言 README 同步**：项目维护三份 README —— `README.md`（英文，权威源）、`README.zh-CN.md`（简体中文）、`README.ja-JP.md`（日本語）。**任何对其中一份的内容改动（新增/删除/修改章节），必须在同一次改动里同步到另外两份**，不要只改一份。提交前用 `ls README*.md` 核对三份都改到。

## Documentation

| 文档                                                    | 内容                                                    |
| ------------------------------------------------------- | ------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)           | 双服务架构、BFF 代理、信任边界、关键决策表              |
| [`docs/DATA-FLOW.md`](docs/DATA-FLOW.md)                 | JSONL → Parser → SQLite → Turns → 前端 完整数据管道 |
| [`docs/API.md`](docs/API.md)                             | Ingest REST/SSE 端点 + BFF 代理路由完整参考             |
| [`docs/db-schema.md`](docs/db-schema.md)                 | SQLite 6 表结构、索引、外键、skip cache、迁移历史       |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md)         | 所有环境变量、默认值、验证规则                          |
| [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)     | 安装、配置、启动、验证步骤                              |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)             | 日常开发命令、约定、添加功能的模式                      |
| [`docs/TESTING.md`](docs/TESTING.md)                     | 测试布局、golden fixture、测试模式                      |
| [`docs/services/ingest.md`](docs/services/ingest.md)     | Ingest 服务深度解析（Hono、解析器、同步、SSE）          |
| [`docs/services/frontend.md`](docs/services/frontend.md) | 前端服务深度解析（路由、注册表、BFF、replay UI）        |

## Skills

实现或修改功能前，**必须**调用以下 skill 获取最新规范，不要凭记忆写代码。调用方式：用 `Skill` tool 或聊天里输入 `/<skill-name>`，**不要**用 Read 读 skill 文件。

### Next.js / 核心栈

| 场景                                                                  | 使用的 skill                     |
| --------------------------------------------------------------------- | -------------------------------- |
| 任何 Next.js 相关功能（路由、渲染、layout、Server Actions）           | `vercel:nextjs`                |
| 写或改 React 组件（结构、hooks、a11y、性能、TS 模式）                 | `vercel:react-best-practices`  |
| 路由拦截、middleware、rewrite/redirect、locale                        | `vercel:routing-middleware`    |
| 缓存策略、Server Component 数据获取、PPR、`use cache`、`cacheTag` | `vercel:next-cache-components` |
| 升级 Next.js 版本（codemods、迁移指南）                               | `vercel:next-upgrade`          |
| 使用或新增 shadcn 组件、theming、自定义 registry                      | `vercel:shadcn`                |
| 处理环境变量（`.env*`、`vercel env`、OIDC token）                 | `vercel:env-vars`              |
| Turbopack 配置、优化 HMR、调试构建问题                                | `vercel:turbopack`             |
| Server-side 代码、Functions、Cron、流式响应                           | `vercel:vercel-functions`      |
| 端到端验证（浏览器 → API → 数据 → 响应）                           | `vercel:verification`          |

### GSD 工作流（本项目用 `.planning/` 跟踪）

| 场景                               | 使用的 skill                                                       |
| ---------------------------------- | ------------------------------------------------------------------ |
| 查看当前进度、决定下一步           | `gsd-progress`                                                   |
| 跨 session 恢复上下文              | `gsd-resume-work`                                                |
| Phase 三段式：讨论 → 规划 → 执行 | `gsd-discuss-phase` / `gsd-plan-phase` / `gsd-execute-phase` |
| 列出全部 GSD 命令                  | `gsd-help`                                                       |

### 本项目 Agent skill

下面是项目内置的 agent 运行时 skill（canonical 源在 `.agents/skills/`，由 `scripts/link-agents.sh` 软链到各工具目录；其他工具目录已 gitignore，不要手动复制）。

| 场景                                                                                                          | 使用的 skill           |
| ------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 检索/定位本地已 ingest 的历史 session：按消息正文全局搜索 → 拿 `source`+`sessionId` → 下钻 detail/turns/messages | `local-session-search` |
