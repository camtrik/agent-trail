# 测试

测试在 **Vitest 4** 的 Node 模式下运行（组件测试引入 jsdom）。同一个运行器覆盖了 ingest 服务、BFF、React 组件代码和解析器 fixture 套件。

```bash
pnpm test                 # 监视模式
pnpm test:run             # 单次运行——CI 执行的命令
pnpm test:real-sessions   # 可选本地语料库测试（使用你真实的本地会话）
pnpm typecheck            # tsc --noEmit（整个工作区）
pnpm typecheck:ingest     # 仅 ingest 项目
pnpm lint                 # ESLint（eslint-config-next flat 配置）
```

工作流上下文请参见 [`DEVELOPMENT.md`](DEVELOPMENT.md)。环境搭建请参见 [`GETTING-STARTED.md`](GETTING-STARTED.md)。

---

## 1. 目录布局

| 路径 | 内容说明 |
| --- | --- |
| `vitest.config.ts` | 单一 Vitest 配置。包含 `tests/**/*.test.{ts,tsx}`、`lib/**/*.test.{ts,tsx}`、`ingest/**/*.test.ts`。默认环境为 `node`。路径别名 `@` → 仓库根目录。 |
| `tests/types.test.ts` | 对规范 trace 合约的类型结构断言。 |
| `tests/fixtures.test.ts` | Golden 文件回归测试：`fixtures/{openclaw,claude-code,codex}/` 下的每个 fixture 与其 `.golden.json` 进行比对。 |
| `tests/fixtures/` | 各 source 的真实格式 JSONL 样本和解析器回归测试 fixtures。 |
| `tests/unit/ingest/` | 解析器、同步、数据源、turn 组装器、数据库迁移、sessions API、工具持久化和回归测试套件。 |
| `tests/unit/bff/` | BFF 行为测试：source 切换路由、sync 路由、turns 分页、replay store hooks、虚拟化和关键工具函数。 |
| `tests/integration/ingest/` | 端到端数据库和 API 测试，使用 `better-sqlite3` 在隔离的 SQLite 文件上运行。 |
| `tests/hooks/` | React hook 测试（`client-hooks.test.tsx`）——使用 jsdom。 |
| `tests/components/` | 组件测试插槽（当前为空）。 |
| `tests/perf/long-session.test.ts` | 超长会话的性能烟雾测试。 |
| `tests/local/real-session-corpus.test.ts` | 针对你本地会话的可选测试；仅在 `RUN_REAL_SESSION_TESTS=1` 时运行。 |
| `tests/helpers/temp-fixture.ts` | 测试期间创建临时解析器 fixtures 的工具函数。 |
| `ingest/api/*.test.ts`、`ingest/sync/*.test.ts`、`ingest/src/*.test.ts` | ingest 内部模块的同目录单元测试。 |
| `lib/agent-tools/*.test.ts(x)` | 与各自模块同目录的适配器和注册表测试。 |

`vitest.config.ts` 有意**不包含**根目录下的 `tests/components/` 占位（尚无条目），但会自动选中匹配 include glob 的任何文件。

---

## 2. Golden fixtures

解析器回归套件使用 `fixtures/` 下提交的一组精选 JSONL 文件：

```text
fixtures/
  openclaw/
    conversation.jsonl, conversation.golden.json
    tool-call.jsonl,    tool-call.golden.json
  claude-code/
    valid_session.jsonl,       valid_session.golden.json
    tool_call_pending.jsonl,   tool_call_pending.golden.json
  codex/
    standard_session.jsonl,    standard_session.golden.json
    function_calls.jsonl,      function_calls.golden.json
```

每对文件对应一次解析器调用：`.jsonl` 是输入，`.golden.json` 是期望的 `ParseResult`。`tests/fixtures.test.ts` 对每个解析器以其输入运行，并执行 `expect(actual).toEqual(expected)`。

### 重新生成 golden 文件

当你有意修改解析器输出结构时：

```bash
# 原地重新生成所有六个 golden 文件
pnpm tsx scripts/generate-golden.ts
```

然后运行 `git diff fixtures/` 确认变更与你期望的解析器改动一致。**不要为了让失败的测试通过而重新生成 golden 文件**——失败的 diff 正是你需要关注的回归问题。只有在你确认新的输出结构正确后才重新生成，然后将 fixtures 和解析器改动一起提交。

脚本源码位于 `scripts/generate-golden.ts`。它使用与运行时相同的解析器（`lib/parseFixture.ts` 是一个薄的分发 shim）。

---

## 3. 可选真实会话测试套件

`pnpm test:real-sessions` 运行 `tests/local/real-session-corpus.test.ts`，该测试**仅在**设置了 `RUN_REAL_SESSION_TESTS=1` 时执行。它会读取 `.local/real-session-corpus.json`（已被 gitignore）——这是一个清单文件，包含指向你真实本地会话文件的路径以及描述它们应验证哪些不变量的标签。如果没有清单文件，测试会清晰地跳过并给出提示信息；它们不会仅仅因为你没有编写清单文件而失败。

清单文件的 schema 参见 `.local/real-session-corpus.example.json`。可识别的标签：

| 标签 | 断言的检查项 |
| --- | --- |
| `has-tool-calls` | 解析和同步后，存在 `tool_calls` 行 |
| `has-subagent` / `claude-subagent` | 组装后的 turns 中至少有 1 个 `subagent_link` 活动 |
| `has-compact` | 至少有 1 个 turn 因 `[compact]` 系统事件被标记为 `isTruncated` |
| `claude-key-null-risk` | 每条消息的 `messages.id` 均为非空（回归类型 606dac00） |
| `claude-discoverability` | 同步后该会话可在 `sessions` 中被发现（回归类型 effac644） |
| `codex-function-output` | Codex 同步后，`tool_calls` 和 `tool_result_events` 已填充 |
| `codex-custom-tool` | 同上，但针对自定义工具变体 |

使用真实会话套件来确保解析器修复不会在你的实际工作负载下出现问题。语料库文件本身是敏感的——它指向可能包含代码和凭据的 JSONL 文件——因此它保持 gitignored 且为可选的。

---

## 4. 各领域测试模式

### 解析器（`tests/unit/ingest/{claude,codex,openclaw}-parser.test.ts`）

- 使用临时 fixture 工具将 JSONL 字符串写入磁盘并调用解析器。
- 断言规范的 `ParseResult` 结构：`session`、`messages[]`、`activities[]`、`errors[]`。
- 对于已知格式，优先扩展 `tests/fixtures/` 而不是内联 JSONL——这样相同的输入可以同时被 `fixtures.test.ts` 和更精确的单元断言所使用。

### 同步（`tests/unit/ingest/sync.test.ts`、`tool-persistence.test.ts`、`phase8-regression.test.ts`）

- 使用隔离数据库：`Database(':memory:')` 或 `${tmpdir}/ingest-test-XXXX.db`。不要共用开发数据库——测试假定自己拥有 schema 的全部控制权。
- 运行 `initSchema()` 和 `runMigrations()` 进行设置。迁移是幂等的（`runMigrations` 对 `ALTER TABLE` 的 `try/catch` 会吞掉"重复列"错误）。
- 通过写入相同解析结果两次，并断言第二次调用时 `sessionsInserted === 1, sessionsUpdated === 0` 来验证跳过缓存的路径。

### Turn 组装器（`tests/unit/ingest/turns.test.ts`、`turn-activity-regression.test.ts`）

- 在内存中（或通过解析器）构建 fixture 会话，调用 `assembleTurns(sessionId, db)`，并断言 `TraceTurn[]` 结构：turn 边界、compact 事件时的 `isTruncated`、排队命令的合并、`subagent_link` 活动。
- 组装器读取 `messages` 行；直接修改 `messages`（例如插入带有 `[compact]` 的系统事件）的测试是合法的。

### BFF（`tests/unit/bff/*.test.ts`）

- Mock `fetchIngest` 而不是启动真实的 ingest 服务器。
- 验证路由的输入处理：无效的 `tool` 返回 400，无效的 `sessionId` 返回 400，ingest 失败返回脱敏后的 502。
- 路径覆盖重点：source 范围限定（`source=` 注入）、limit 上限为 100、错误脱敏处理。

### 组件与 Hooks

- `tests/hooks/client-hooks.test.tsx` 使用 `@testing-library/react` + jsdom。将消费者包装在 `<AgentToolProvider toolId="openclaw">` 中以满足上下文要求。
- 对于获取 BFF 的数据 hooks，mock `globalThis.fetch` 并断言请求 URL（例如 `/api/agent-tools/openclaw/sessions?...`）。

### 性能测试

- `tests/perf/long-session.test.ts` 覆盖最坏情况的会话大小。将性能预算保持在实际范围内（Vitest 会报告每个测试的耗时）；不稳定的性能测试比没有性能测试更糟糕。

---

## 5. 运行单个测试

```bash
# 按文件
pnpm vitest run tests/unit/ingest/turns.test.ts

# 按名称
pnpm vitest run -t 'should mark turn truncated on compact event'

# 监视单个文件
pnpm vitest tests/unit/bff/sync-route.test.ts
```

`pnpm vitest`（不带 `run`）默认进入监视模式。使用打印的 Vitest UI 或按 `q` 退出。

---

## 6. 覆盖率

覆盖率目前未配置（`vitest.config.ts` 中没有 `coverage` 块）。要添加它，请安装 `@vitest/coverage-v8`，在 `vitest.config.ts` 中添加 `test.coverage` 块，然后运行 `pnpm vitest run --coverage`。<!-- VERIFY: confirm whether coverage is intentionally disabled in CI; if a CI-side coverage step exists, it lives outside this repo -->

---

## 7. CI 注意事项

本仓库中没有签入 CI 工作流（`.github/workflows/` 目录不存在）。预期的托管 CI 设置运行 `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:run`。<!-- VERIFY: confirm the actual CI command if a CI service is configured outside this repo -->

在添加 CI 时，建议：

- 使用单次 `vitest run` 调用（监视模式是面向开发者的）。
- 同时运行 `pnpm typecheck` 和 `pnpm typecheck:ingest`——它们检查不同的 `tsconfig.json` 文件，能发现跨项目的类型不一致。
- `RUN_REAL_SESSION_TESTS` 在 CI 中应保持关闭；该套件仅供本地开发者使用。

## PR 检查

`.github/workflows/quality.yml` 使用 Node 24 / pnpm 11.1.3，执行冻结锁文件安装、lint、两项 typecheck、测试和双服务构建。lint 排除生成包、构建产物、worktree 与历史设计稿，仍检查源码错误。
