<div align="center">

# Agent Trail

[English](README.md) · **简体中文** · [日本語](README.ja-JP.md)

**本地 AI 编程代理可观测性仪表盘，支持 Claude Code、Codex、OpenCode、OpenClaw、Qoder 和 Command Code。**

从本地 JSONL / SQLite 文件追踪 token 用量、预估成本、工具调用、子代理树，并完整回放编程代理会话。

🏠 [camtrik.github.io/agent-trail](https://camtrik.github.io/agent-trail/)

[![npm version](https://img.shields.io/npm/v/%40camtrik%2Fagent-trail?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@camtrik/agent-trail)
[![GitHub stars](https://img.shields.io/github/stars/camtrik/agent-trail?style=for-the-badge&logo=github&color=181717)](https://github.com/camtrik/agent-trail)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

![概览仪表盘](image/README/1779286882349.png)

![会话回放](image/README/1779290188740.png)

</div>

---

## 它能做什么

### 跨代理用量概览

统一的仪表盘聚合展示 Claude Code、OpenClaw、Codex、OpenCode 和 Qoder 的 token 消耗与预估成本 — 按天、会话、项目、模型细粒度拆分。一目了然：

- 任意时间窗口（今日 / 本周 / 全部）的总 token 和预估美元成本
- 按项目和模型拆分，附带时间趋势
- 哪些会话消耗最多 token、预算流向何处
- 新会话写入磁盘时的实时活动流

所有数据均从代理已有的 JSONL 文件本地计算。

### 完整会话回放，含工具调用和子代理详情

打开任意会话，逐步回放每个轮次的全过程。回放视图超越原始文本 — 展示每个 assistant 轮次的内部结构：

- **工具调用**：展开任意 `Bash`、`Read`、`Edit`、`Write` 或自定义工具调用，查看精确的输入参数和模型接收到的完整输出
- **子代理生成**：当 Claude Code 或 OpenClaw 启动子代理时，仪表盘渲染嵌套的代理树，方便追踪委托了哪个子任务、接收了什么指令、返回了什么结果
- **注入上下文和系统事件**：展示隐藏的上下文块、权限提示和合成消息 — 这些通常在轮次之间存在，但塑造了模型的行为
- **每轮次 token 统计**：查看 input、output、cache-read、cache-write 和 reasoning token 计数，精确到轮次级别

### 让你的编程代理搜索历史会话

Agent Trail 内置了一个代理 skill **`local-session-search`**，教会 AI 编程代理（Claude Code、Codex 等）通过本地 ingest/BFF 接口查找你的历史会话 —— 即使你事先不知道会话 ID。

- 可以直接问代理：*"找一下我之前调试 WebSocket 重连那个 bug 的会话"*。
- skill 会先用消息正文全局搜索（`GET /api/v1/sessions/search`）找出候选会话，再下钻到会话详情 / 轮次 / 消息来作答。
- 它返回足够的元数据 —— `source`、`sessionId`、标题、项目、`updatedAt` 以及命中片段 —— 让代理定位并打开正确的会话。

该 skill 位于 [`.agents/skills/local-session-search/SKILL.md`](.agents/skills/local-session-search/SKILL.md)。

---

## 安装

### 方式一 — npm（推荐，任意 Node.js 22+）

```bash
npm install -g @camtrik/agent-trail
agent-trail
```

更新已有的全局安装：

```bash
npm update -g @camtrik/agent-trail
# 或强制安装最新发布版本：
npm install -g @camtrik/agent-trail@latest
```

兼容 Node 22、24 及更高版本 — `npm install` 会自动解析适配你本地 ABI 的原生模块（better-sqlite3）。首次安装约需 30 秒下载依赖。

运行时日志默认静默。如需详细诊断：

```bash
AGENT_TRAIL_LOG_LEVEL=debug agent-trail
```

### 方式二 — Docker 本地构建

```bash
git clone https://github.com/camtrik/agent-trail.git
cd agent-trail
docker compose up --build
```

默认 Compose 文件在 Docker 内使用 Node 24 本地构建应用，宿主机不需要安装 Node.js。

打开 [http://localhost:3030](http://localhost:3030)。

### 方式三 — Docker 已发布镜像

```bash
docker compose -f docker-compose.image.yml up -d
```

或直接运行已发布镜像：

```bash
docker run --rm -p 127.0.0.1:3030:3030 \
  -v "$HOME/.claude/projects:/agents/claude:ro" \
  -e CLAUDE_PROJECTS_DIR=/agents/claude \
  ghcr.io/camtrik/agent-trail:latest
```

打开 [http://localhost:3030](http://localhost:3030)。通过 `-v` 和对应的环境变量（`OPENCLAW_DIR`、`CODEX_SESSIONS_DIR`、`OPENCODE_DB_PATH`）挂载更多代理目录。

### 方式四 — 从源码运行

```bash
pnpm install
pnpm dev       # 启动 Next.js (3029) + 摄入服务 (8078)
```

完整配置和环境变量参考见 [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)。

---

## 卸载

### npm 全局安装

```bash
npm uninstall -g @camtrik/agent-trail
```

清理打包应用创建的本地索引/配置（可选）：

```bash
rm -rf ~/.agent-trail
```

此操作不会删除你原有的 Claude Code、OpenClaw、Codex、OpenCode 或 Qoder 会话文件。

### Docker Compose

停止并移除容器：

```bash
docker compose down
# 如果使用的是已发布镜像的 compose 文件：
docker compose -f docker-compose.image.yml down
```

清理 Docker 数据卷（存储仪表盘 SQLite 索引，可选）：

```bash
docker compose down -v
# 或：
docker compose -f docker-compose.image.yml down -v
```

可选清理镜像：

```bash
docker image rm agent-trail:local
docker image rm ghcr.io/camtrik/agent-trail:latest
```

---

## 支持的 AI 编程代理

| 代理                   | 源文件                                      | 备注                             |
| ---------------------- | ------------------------------------------- | -------------------------------- |
| **Claude Code**        | `~/.claude/projects/**/*.jsonl`             | 完整工具调用和子代理回放         |
| **OpenClaw** | `~/.openclaw/agents/*/agent/openclaw-agent.sqlite` + 归档 JSONL | 运行中 SQLite 与旧归档 |
| **Codex**              | `~/.codex/sessions/**/*.jsonl`              | 父子会话树                       |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | 旧版与 v2 SQLite schema |
| **Qoder** | 旧 IDE 本地缓存数据库 | 当前 IDE/Desktop/CLI 兼容性仍待验证 |
| **Command Code** | `~/.commandcode/projects/**/*.jsonl` | v3 历史和记录成本；可能没有子代理内部轨迹 |

---

## 使用场景

Agent Trail 适用于以下场景：

- 审查 **Claude Code** 的工具调用、子代理树和注入上下文
- 逐步回放 **Codex**、**OpenCode**、**OpenClaw** 或 **Qoder** 的编程会话
- 在本地追踪多个代理的 **LLM token 用量和预估成本**
- 分析哪些会话或项目消耗了最多的 token
- 调试昂贵或失败的 AI 编程代理运行
---

## 兼容性与许可证

源码开发使用 Node.js 24、pnpm 11.1.3、前端端口 3029 和 ingest 端口 8078。npm/Docker 的前端端口为 3030。请在父进程 shell 设置 INGEST_PORT，使两个服务共同继承。

已验证格式、当前存储限制和重建索引方法见[兼容矩阵](docs/COMPATIBILITY.md)。本维护批次对应 v0.2.0，已安装的 v0.1.7 需要升级才能获得这些改动。

项目自有源码、文档和品牌资产按 [MIT 许可证](LICENSE) 发布；第三方依赖保留各自许可证。

---

## 隐私

这是一个**纯本地**工具。没有任何数据离开你的机器。

- JSONL 文件被解析并索引到本地 SQLite 数据库（`data/ingest.db`）。
- 仪表盘是只读的 — 它回放记录的工具调用，从不重新执行它们。
---


