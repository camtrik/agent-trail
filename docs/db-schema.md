# 数据库 Schema 参考

当前 schema 版本为 **24**。下文迁移表为历史摘要；完整结构以 `ingest/db/schema.sql` 与 `runMigrations()` 为准。v24 扩展 Command Code source 约束并保留数据、索引、trigger 与外键；token usage JSON 可含 requestId/sourceCostUsd，不需要新增列。
SQLite 读取模型，位于 `data/ingest.db`。由 ingest 服务（`ingest/db/`）管理。使用 WAL 模式以支持并发读写。

---

## 配置

| 配置项 | 值 | 来源 |
| --- | --- | --- |
| 路径 | `data/ingest.db`（默认）或 `INGEST_DB_PATH` | `ingest/config/index.ts` |
| Journal 模式 | WAL | `schema.sql` 中的 `PRAGMA journal_mode = WAL` |
| Synchronous | NORMAL | `schema.sql` 中的 `PRAGMA synchronous = NORMAL` |
| 迁移追踪 | `PRAGMA user_version` | `db/index.ts` 中的 `runMigrations()` |
| 驱动 | `better-sqlite3`（同步 API） | `db/index.ts` |

---

## 表

### sessions

每个 session 文件一行。包含元数据、文件来源、指标和关系数据。

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | TEXT | **PK** | Session ID（例如 Claude Code 为 UUID，OpenClaw 为 `agent:{name}:{uuid}`） |
| `source` | TEXT | NOT NULL, CHECK IN (`openclaw`, `claude-code`, `codex`, `opencode`, `qoder`, `commandcode`) | 产生此 session 的 agent 工具 |
| `project` | TEXT | NOT NULL | 解码后的 project/cwd 路径 |
| `name` | TEXT | nullable | 从第一条用户消息中提取的显示名称 |
| `started_at` | TEXT | nullable | 第一条消息的 ISO 8601 时间戳 |
| `ended_at` | TEXT | nullable | 最后一条消息的 ISO 8601 时间戳 |
| `status` | TEXT | NOT NULL, CHECK IN (`active`, `idle`, `aborted`, `error`, `unknown`) | 由解析器确定的 session 状态 |
| `root_session_id` | TEXT | nullable, FK → sessions.id | 子 agent 树中的顶层 session |
| `parent_session_id` | TEXT | nullable, FK → sessions.id | 子 agent 层级中的直接父节点 |
| `relationship_type` | TEXT | nullable, CHECK IN (`root`, `subagent`, `fork`, `continuation`) | 此 session 与其父节点的关系类型 |
| `message_count` | INTEGER | NOT NULL, DEFAULT 0 | session 中的总消息数 |
| `user_message_count` | INTEGER | NOT NULL, DEFAULT 0 | 仅 user 角色的消息数 |
| `total_output_tokens` | INTEGER | nullable | 各轮输出 token 的总和 |
| `has_tool_calls` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | 是否存在工具调用 |
| `file_path` | TEXT | NOT NULL | 磁盘上源 JSONL 文件的绝对路径 |
| `file_size` | INTEGER | nullable | 文件大小（字节） |
| `file_mtime` | TEXT | nullable | 文件修改时间（ISO 8601） |
| `file_hash` | TEXT | nullable | 带版本的解析器缓存键：`{version}:{source}:{sha256}` |
| `last_sync_at` | TEXT | nullable | 最近一次成功同步的时间戳（ISO 8601） |
| `cwd` | TEXT | nullable | session 元数据中的工作目录 |
| `git_branch` | TEXT | nullable | session 元数据中的 Git 分支 |
| `source_session_id` | TEXT | nullable | 源工具中的原始 session ID |
| `source_version` | TEXT | nullable | 源工具的版本字符串 |
| `parser_malformed_lines` | INTEGER | NOT NULL, DEFAULT 0 | 无法解析的 JSONL 行数 |
| `is_truncated` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | 上下文窗口是否被压缩 |
| `termination_status` | TEXT | nullable | session 结束方式（例如 `completed`、`cancelled`） |
| `source_cost_usd` | REAL | nullable | Source-reported cost in USD (opencode reports exact cost) |
| `cost_source` | TEXT | nullable | Cost source: `'source-reported'` for opencode, null for pricing registry estimates |
| `cost_pricing_status` | TEXT | nullable | Pricing status: `'priced'` (exact), `'reported_zero'` (cost=0 with tokens), null for estimates |

**外键：**
- `root_session_id` → `sessions.id` ON DELETE SET NULL
- `parent_session_id` → `sessions.id` ON DELETE SET NULL

---

### messages

扁平化、有序的消息列表。每个 session 中的每条消息一行。

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | TEXT | **PK** | 消息 ID，来自解析器，或回退为 `{sessionId}:{ordinal}` |
| `session_id` | TEXT | NOT NULL, FK → sessions.id | 所属 session |
| `ordinal` | INTEGER | NOT NULL | session 中的 0-based 位置 |
| `role` | TEXT | NOT NULL, CHECK IN (`user`, `assistant`, `system`, `tool_result`) | 消息角色 |
| `content` | TEXT | NOT NULL | 原始消息内容（可能包含 XML 标签） |
| `timestamp` | TEXT | nullable | ISO 8601 |
| `model` | TEXT | nullable | 模型名称（例如 `claude-sonnet-4-6`） |
| `has_tool_use` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | assistant 内容块中是否包含 tool_use |
| `turn_id` | TEXT | nullable | 此消息所属的 turn（由解析器填充） |
| `turn_index` | INTEGER | nullable | turn 索引（由解析器填充） |
| `is_real_user_input` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | 区分真实用户输入与注入的元数据 |
| `token_usage_json` | TEXT | nullable | JSON 序列化的 `TokenUsage` 对象 |
| `source_file` | TEXT | nullable | 源 JSONL 文件路径 |
| `source_line` | INTEGER | nullable | 源 JSONL 文件中的行号 |

**唯一约束：** `UNIQUE(session_id, ordinal)`

**外键：**
- `session_id` → `sessions.id` ON DELETE CASCADE

---

### tool_calls

从 assistant 消息内容块中提取的单个工具调用记录。

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | 自增行 ID |
| `session_id` | TEXT | NOT NULL, FK → sessions.id | 所属 session |
| `message_ordinal` | INTEGER | NOT NULL | 关联到包含此工具调用的 assistant 消息 |
| `tool_id` | TEXT | NOT NULL | 源中的工具调用 ID（例如 `toolu_01ABC...`） |
| `name` | TEXT | NOT NULL | 工具名称（例如 `Bash`、`Edit`、`Read`） |
| `category` | TEXT | nullable, CHECK IN (`Bash`, `Edit`, `Read`, `Grep`, `Task`, `Agent`, `Other`) | 工具类别 |
| `input_json` | TEXT | NOT NULL | 工具输入参数的 JSON 字符串 |
| `status` | TEXT | NOT NULL, CHECK IN (`pending`, `success`, `error`) | 工具执行状态 |
| `error` | TEXT | nullable | 状态为 `error` 时的错误消息 |
| `duration_ms` | INTEGER | nullable | 执行耗时（毫秒） |

**外键：**
- `session_id` → `sessions.id` ON DELETE CASCADE

---

### tool_result_events

工具执行的输出事件。一个工具调用可有多个事件（例如流式输出）。

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | INTEGER | **PK**, AUTOINCREMENT | 自增行 ID |
| `tool_call_id` | INTEGER | NOT NULL, FK → tool_calls.id | 所属工具调用 |
| `timestamp` | TEXT | nullable | ISO 8601 |
| `content` | TEXT | NOT NULL | 事件内容（stdout、文件内容等） |
| `is_partial` | INTEGER | NOT NULL, DEFAULT 0, CHECK IN (0, 1) | 是否为部分/流式事件 |

**外键：**
- `tool_call_id` → `tool_calls.id` ON DELETE CASCADE

---

### turns

预计算或由组装器构建的 turn 行。一个 turn 将一条用户消息与其后续的 assistant/tool_result 消息分组。

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `id` | TEXT | **PK** | Turn ID（通常为 `{sessionId}-turn-{index}`） |
| `session_id` | TEXT | NOT NULL, FK → sessions.id | 所属 session |
| `turn_index` | INTEGER | NOT NULL | 0-based turn 位置 |
| `user_message_id` | TEXT | nullable, FK → messages.id | 开启此 turn 的用户消息 |
| `started_at` | TEXT | nullable | ISO 8601 |
| `ended_at` | TEXT | nullable | ISO 8601 |
| `duration_ms` | INTEGER | nullable | Turn 耗时 |
| `token_usage_json` | TEXT | nullable | 此 turn 的 JSON 序列化 `TokenUsage` |

**唯一约束：** `UNIQUE(session_id, turn_index)`

**外键：**
- `session_id` → `sessions.id` ON DELETE CASCADE
- `user_message_id` → `messages.id` ON DELETE SET NULL

---

### sync_status

每个数据源的同步健康追踪。每个 source 类型一行。

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `source_type` | TEXT | **PK** | 数据源类型（`openclaw`、`claude-code`、`codex`、`opencode`） |
| `last_full_sync_at` | TEXT | nullable | 最近一次全量重新同步的时间戳 |
| `last_watch_sync_at` | TEXT | nullable | 最近一次文件监听触发的同步时间戳 |
| `files_watched` | INTEGER | NOT NULL, DEFAULT 0 | 已处理的 session 文件数 |
| `last_error` | TEXT | nullable | 最近一条错误消息（健康时为 null） |

---

## 索引

### sessions

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_sessions_source_project` | `(source, project)` | 按数据源和项目过滤 session |
| `idx_sessions_started_at` | `(started_at DESC)` | 按最近时间排序 |
| `idx_sessions_root_session_id` | `(root_session_id)` | 子 agent 树遍历 |
| `idx_sessions_parent_session_id` | `(parent_session_id)` | 直接父节点查找 |

### messages

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_messages_session_id` | `(session_id)` | 获取一个 session 的所有消息 |
| `idx_messages_session_ordinal` | `(session_id, ordinal)` | 有序消息检索（带唯一约束） |
| `idx_messages_session_turn_index` | `(session_id, turn_index)` | 按 turn 排序的消息查找（由迁移添加） |

### tool_calls

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_tool_calls_session_id` | `(session_id)` | 一个 session 的所有工具调用 |
| `idx_tool_calls_message_ordinal` | `(message_ordinal)` | 按消息查找工具调用 |

### tool_result_events

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_tool_result_events_tool_call_id` | `(tool_call_id)` | 特定工具调用的事件 |

### turns

| Index | Columns | Purpose |
| --- | --- | --- |
| `idx_turns_session_id` | `(session_id)` | 一个 session 的所有 turn |
| `idx_turns_session_index` | `(session_id, turn_index)` | 有序 turn 检索 |

---

## 实体关系

```text
sessions (1) ──< (N) messages
  │                    │
  │                    └── ordinal → links to tool_calls.message_ordinal
  │
  ├─< (N) tool_calls ──< (N) tool_result_events
  │
  ├─< (N) turns
  │
  └── self-referential:
       root_session_id   → sessions.id (subagent tree root)
       parent_session_id → sessions.id (direct parent)
```

级联删除从 sessions 流向 messages、tool_calls、turns。tool_calls → tool_result_events 同样级联。

---

## 跳过缓存

`file_hash` 列实现了跳过缓存，避免重复解析未更改的文件：

1. 计算源 JSONL 文件的 SHA-256
2. 构建带版本的缓存键：`{PARSER_CACHE_VERSION}:{source}:{sha256}`
3. 与 `sessions.file_hash` 比较
4. 若匹配：跳过完整解析，仅在 `name`/`project` 为空时补丁
5. 若不匹配（或 NULL）：完整 upsert —— 删除派生行，重新插入

`PARSER_CACHE_VERSION` 为 `parser-v11-qoder-token-calibrated-cost`。当解析器逻辑变更时，递增此版本号将使所有缓存的 session 失效。

**强制重新解析：** `writeSessionToDatabase()` 接受 `{ force: true }` 参数以完全绕过跳过缓存。

---

## 迁移

通过 `runMigrations()` 中的 `PRAGMA user_version` 管理（`ingest/db/index.ts`）。当前目标版本：**v6**。

| 迁移 | 描述 |
| --- | --- |
| v1 | 向 sessions 表添加 `file_hash`、`last_sync_at` 列 |
| v2 | 向 sessions 表添加 `name` 列 |
| v3 | 使跳过缓存失效，以修复名称提取 |
| v4 | 使解析器 cwd 修复后的过期 project/name 行失效 |
| v5 | 向 messages 表添加 `turn_id`、`turn_index`、`is_real_user_input` 列；添加 `idx_messages_session_turn_index` |
| v6 | 使 Claude/Codex 解析器缓存失效，以修复 turn/关系 |

迁移使用 `ALTER TABLE ADD COLUMN` 包裹在 try/catch 中，以优雅处理已应用的列。Schema 在首次运行时始终从 `schema.sql` 全新创建；迁移用于处理已有数据库的升级。

---

## 生命周期

1. **启动：** `openDatabase()` 创建目录，打开 SQLite，启用 WAL
2. **初始化：** `initSchema()` 执行 `schema.sql` → `runMigrations()` → 验证所有核心表存在
3. **运行时：** `writeSessionToDatabase()` 执行事务写入；`assembleTurns()` 执行读取查询
4. **关闭：** `closeDatabase()` 干净地关闭连接

数据库模块导出一个单例 `db` 句柄。所有其他模块通过 `getDatabase()` 导入以访问它。
