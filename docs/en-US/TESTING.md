# Testing

Tests run on **Vitest 4** in Node mode (with jsdom pulled in for component tests). The same runner covers the ingest service, the BFF, the React component code, and the parser fixture suites.

```bash
pnpm test                 # watch mode
pnpm test:run             # single pass — what CI runs
pnpm test:real-sessions   # opt-in local corpus (uses your real local sessions)
pnpm typecheck            # tsc --noEmit (whole workspace)
pnpm typecheck:ingest     # ingest project only
pnpm lint                 # ESLint (eslint-config-next flat)
```

For workflow context, see [`DEVELOPMENT.md`](DEVELOPMENT.md). For setup, see [`GETTING-STARTED.md`](GETTING-STARTED.md).

---

## 1. Layout

| Path | What lives here |
| --- | --- |
| `vitest.config.ts` | Single Vitest config. Includes `tests/**/*.test.{ts,tsx}`, `lib/**/*.test.{ts,tsx}`, `ingest/**/*.test.ts`. Default environment is `node`. Path alias `@` → repo root. |
| `tests/types.test.ts` | Type-shape assertions on the canonical trace contract. |
| `tests/fixtures.test.ts` | Golden-file regression: every fixture in `fixtures/{openclaw,claude-code,codex,opencode}/` parsed against its `.golden.json`. |
| `tests/fixtures/` | Source-specific real-shape JSONL captures and parser-regression fixtures. |
| `tests/unit/ingest/` | Parser, sync, sources, turn-assembler, db-migration, sessions-API, tool-persistence, regression suites. |
| `tests/unit/bff/` | BFF behaviour: source-switcher routing, sync route, turns pagination, replay store hooks, virtualization, key utils. |
| `tests/integration/ingest/` | End-to-end DB and API tests using `better-sqlite3` against an isolated SQLite file. |
| `tests/hooks/` | React hook tests (`client-hooks.test.tsx`) — uses jsdom. |
| `tests/components/` | Component test slot (currently empty). |
| `tests/perf/long-session.test.ts` | Performance smoke for very long sessions. |
| `tests/local/real-session-corpus.test.ts` | Opt-in tests against your local sessions; only runs when `RUN_REAL_SESSION_TESTS=1`. |
| `tests/helpers/temp-fixture.ts` | Helpers for spinning up temporary parser fixtures during tests. |
| `ingest/api/*.test.ts`, `ingest/sync/*.test.ts`, `ingest/src/*.test.ts` | Co-located unit tests for ingest internals. |
| `lib/agent-tools/*.test.ts(x)` | Adapter and registry tests co-located with their modules. |

`vitest.config.ts` deliberately **does not** include the root `tests/components/` placeholder (no entries yet) but will pick anything matching the include glob automatically.

---

## 2. Golden fixtures

The parser regression suite uses a small set of hand-picked JSONL files committed under `fixtures/`:

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

Each pair is one parser invocation: the `.jsonl` is the input, the `.golden.json` is the expected `ParseResult`. `tests/fixtures.test.ts` runs every parser against its input and `expect(actual).toEqual(expected)`.

### Regenerating goldens

When you intentionally change parser output shape:

```bash
# Regenerates all six golden files in place
pnpm tsx scripts/generate-golden.ts
```

Then `git diff fixtures/` to confirm the changes match the parser change you intended. **Don't regenerate goldens to make a failing test pass** — the failing diff is the regression you need to look at. Regenerate only after you've confirmed the new shape is correct, then commit fixtures + parser change together.

The script source is `scripts/generate-golden.ts`. It uses the same parsers the runtime does (`lib/parseFixture.ts` is a thin dispatch shim).

---

## 3. The opt-in real-session suite

`pnpm test:real-sessions` runs `tests/local/real-session-corpus.test.ts`, which **only executes** when `RUN_REAL_SESSION_TESTS=1` is set. It reads `.local/real-session-corpus.json` (gitignored) — a manifest of paths to your real local session files plus tags describing what invariants they should exercise. Without the manifest the tests skip with a clear message; they will not fail just because you haven't written one.

The manifest schema is documented in `.local/real-session-corpus.example.json`. Recognised tags:

| Tag | What gets asserted |
| --- | --- |
| `has-tool-calls` | After parsing + sync, `tool_calls` rows exist |
| `has-subagent` / `claude-subagent` | At least one `subagent_link` activity in the assembled turns |
| `has-compact` | At least one turn marked `isTruncated` from a `[compact]` system event |
| `claude-key-null-risk` | `messages.id` is non-null for every message (regression class 606dac00) |
| `claude-discoverability` | The session is discoverable in `sessions` after sync (regression class effac644) |
| `codex-function-output` | After Codex sync, `tool_calls` and `tool_result_events` are populated |
| `codex-custom-tool` | Same, but for custom-tool variants |

Use the real-session suite to keep parser fixes from breaking under your actual workload. The corpus file itself is sensitive — it points to JSONL that may contain code and credentials — so it stays gitignored and is opt-in.

---

## 4. Test patterns by area

### Parsers (`tests/unit/ingest/{claude,codex,openclaw}-parser.test.ts`)

- Use the temp-fixture helper to write a JSONL string to disk and invoke the parser.
- Assert the canonical `ParseResult` shape: `session`, `messages[]`, `activities[]`, `errors[]`.
- For known formats, prefer extending `tests/fixtures/` over inlining the JSONL — that way the same input can be exercised by both `fixtures.test.ts` and a tighter unit assertion.

### Sync (`tests/unit/ingest/sync.test.ts`, `tool-persistence.test.ts`, `phase8-regression.test.ts`)

- Use an isolated DB: `Database(':memory:')` or `${tmpdir}/ingest-test-XXXX.db`. Don't share the dev DB — tests assume they own the schema.
- Run `initSchema()` and `runMigrations()` to set up. Migrations are idempotent (the `runMigrations` `try/catch` around `ALTER TABLE` swallows "duplicate column" errors).
- Verify the skip-cache path by writing the same parse result twice and asserting `sessionsInserted === 1, sessionsUpdated === 0` on the second call.

### Turn assembler (`tests/unit/ingest/turns.test.ts`, `turn-activity-regression.test.ts`)

- Build a fixture session in memory (or via parser), call `assembleTurns(sessionId, db)`, and assert `TraceTurn[]` shape: turn boundaries, `isTruncated` on compact, queued-command merging, `subagent_link` activities.
- The assembler reads `messages` rows; tests that mutate `messages` (e.g. inserting a system event with `[compact]`) directly are valid.

### BFF (`tests/unit/bff/*.test.ts`)

- Mock `fetchIngest` rather than spinning a real ingest server.
- Validate the route's input handling: invalid `tool` returns 400, invalid `sessionId` returns 400, ingest failures return sanitized 502.
- Path-coverage focus: source scoping (`source=` injection), limit capping at 100, error sanitization.

### Components & hooks

- `tests/hooks/client-hooks.test.tsx` uses `@testing-library/react` + jsdom. Wrap consumers in `<AgentToolProvider toolId="openclaw">` to satisfy the context.
- For data hooks that fetch the BFF, mock `globalThis.fetch` and assert request URLs (e.g. `/api/agent-tools/openclaw/sessions?...`).

### Performance

- `tests/perf/long-session.test.ts` covers worst-case session sizes. Keep the budget realistic (Vitest reports per-test timing); flaky perf tests are worse than no perf tests.

---

## 5. Running a single test

```bash
# By file
pnpm vitest run tests/unit/ingest/turns.test.ts

# By name
pnpm vitest run -t 'should mark turn truncated on compact event'

# Watch a single file
pnpm vitest tests/unit/bff/sync-route.test.ts
```

`pnpm vitest` (without `run`) defaults to watch mode. Use the printed Vitest UI or `q` to quit.

---

## 6. Coverage

Coverage is not currently configured (`vitest.config.ts` has no `coverage` block). To add it, install `@vitest/coverage-v8`, add a `test.coverage` block to `vitest.config.ts`, and run `pnpm vitest run --coverage`. <!-- VERIFY: confirm whether coverage is intentionally disabled in CI; if a CI-side coverage step exists, it lives outside this repo -->

---

## 7. CI considerations

There is no CI workflow checked into this repo (`.github/workflows/` is absent). The expected hosted setup runs `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:run`. <!-- VERIFY: confirm the actual CI command if a CI service is configured outside this repo -->

When CI is added, prefer:

- A single `vitest run` invocation (watch mode is for humans).
- `pnpm typecheck` and `pnpm typecheck:ingest` together — they exercise different `tsconfig.json` files and catch cross-project drift.
- `RUN_REAL_SESSION_TESTS` should remain off in CI; that suite is local-developer-only.

## Pull request checks

`.github/workflows/quality.yml` runs frozen-lockfile installation, lint, both typechecks, tests, and both service builds on Node 24 with pnpm 11.1.3. Generated packages, build output, worktrees and historical design drafts are excluded from lint; source errors remain enforced.
