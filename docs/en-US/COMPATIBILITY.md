# Runtime and data compatibility

This records the implementation and verification scope of the 2026-11-11 maintenance batch for v0.2.0. Existing v0.1.7 installations need an upgrade to receive these changes.

## Runtime

Use Node.js 24 and the packageManager-pinned pnpm 11.1.3 for development. The published package declares its minimum Node version in engines; compressed transcripts also depend on the adapter's runtime support and diagnostics.

| Launch method | Frontend | Default ingest port |
| --- | --- | --- |
| Source: pnpm dev / pnpm start:all | http://localhost:3029 | 8078 |
| npm: agent-trail | http://localhost:3030 | 8078 |
| Docker / Compose | http://localhost:3030 | 8078 |

Pass INGEST_PORT to the parent process, for example `INGEST_PORT=8081 pnpm dev`, so ingest and the BFF inherit it together. INGEST_URL explicitly overrides the BFF upstream. Next.js loads .env.local; the separate ingest process does not. Configure source paths in ~/.agent-trail/config.json or export the source environment variables.

Source scripts explicitly use frontend port 3029. For another dev port, run `INGEST_PORT=8081 pnpm dev:ingest` and `INGEST_PORT=8081 pnpm exec next dev --webpack --port 3031` separately. PORT configures the npm/Docker frontend.

## Covered formats

Verification uses official schemas and synthetic redacted fixtures, rather than launching every latest upstream product.

| Source | Covered format | Limits |
| --- | --- | --- |
| Claude Code | JSONL messages, tools/subagents; api-request and api-request-blob snapshots are ignored | Tiered estimates require request identity and usage; missing evidence stays unknown/partial |
| Codex | Legacy and payload metadata; id identifies the physical rollout while session_id / thread_spawn carry lineage | Children remain independent when the parent file is absent; later sync fills relationships |
| OpenCode | Legacy session/message/part; 2.x session_v2/session_message; split session_part | V2 wins duplicate IDs in mixed databases; unknown schemas fail clearly |
| OpenClaw | Legacy/archive JSONL and v2026.11.3 per-agent SQLite storage | Hot JSON/zstd events are supported; cold/standalone archive blobs remain undecoded with parser-warning/partial diagnostics |
| Command Code | V3 historical JSONL, title sidecars, tool arguments/results and recorded usage/cost | Unrecorded child-agent conversations cannot be restored; parent costs do not cover all child calls |
| Qoder | Legacy IDE local.db chat_session/chat_record/chat_message | Only local Qoder 1.7.0 schema was inspected; current IDE/Desktop/CLI need newer schema/fixtures |

OpenClaw's default active database is ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite; the sessions directory retains archives. OpenCode uses ~/.local/share/opencode/opencode.db by default. Both upstream databases are opened read-only.

## Reindexing and cost

Parser cache versions invalidate stale indexes. Refresh through the UI or send `{"force":true}` to the appropriate BFF sync route. Avoid deleting ingest.db first: it also contains local metadata such as favorites. Original transcripts and upstream databases are not modified.

Source-reported costs take precedence over model estimates. Claude Haiku 5.5 tiers use each request's complete prompt, including cache reads/writes, before costs are summed. Session totals cannot select a request's tier, and missing usage is not a zero-cost request.

## Maintenance checks and license

PR CI runs frozen-lockfile install, lint, both typechecks, tests, and both service builds. Local real-session tests require explicit opt-in and never read user transcripts in CI.

Project-authored source, documentation and brand assets use the root MIT LICENSE. Third-party dependencies retain their own licenses. Packaging requires an explicit license declaration and text.

## Primary sources

- [OpenClaw storage](https://docs.openclaw.ai/concepts/session) and [v2026.11.3 schema](https://github.com/openclaw/openclaw/blob/v2026.11.3/src/state/openclaw-agent-schema.sql)
- [OpenCode session schema](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/sql.ts)
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Qoder IDE](https://changelog.qoder.com/ide) and [CLI](https://changelog.qoder.com/cli) releases
