<div align="center">

# Agent Trail

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語**

**Claude Code、Codex、OpenCode、OpenClaw、Qoder、Command Code に対応したローカル AI コーディングエージェント可観測性ダッシュボード。**

ローカルの JSONL / SQLite ファイルからトークン使用量、推定コスト、ツール呼び出し、サブエージェントツリーを追跡し、コーディングエージェントセッションを完全にリプレイ。

🏠 [camtrik.github.io/agent-trail](https://camtrik.github.io/agent-trail/)

[![npm version](https://img.shields.io/npm/v/%40camtrik%2Fagent-trail?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@camtrik/agent-trail)
[![GitHub stars](https://img.shields.io/github/stars/camtrik/agent-trail?style=for-the-badge&logo=github&color=181717)](https://github.com/camtrik/agent-trail)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

![概要ダッシュボード](image/README/1779286882349.png)

![セッションリプレイ](image/README/1779290188740.png)

</div>

---

## 機能

### 全エージェントの使用量概要

統一されたダッシュボードが Claude Code、OpenClaw、Codex、OpenCode、Qoder のトークン消費量と推定コストを集計し、日別・セッション別・プロジェクト別・モデル別に分類します。一目で確認できる項目：

- 任意の期間（今日 / 今週 / 全期間）の総トークン数と推定 USD コスト
- プロジェクト別・モデル別の内訳と時系列トレンド
- 最もトークンを消費したセッションと予算の使途
- 新しいセッションがディスクに書き込まれる際のリアルタイムアクティビティフィード

すべてエージェントが既に生成している JSONL ファイルからローカルで計算。

### ツール呼び出しとサブエージェント詳細を含む完全なセッションリプレイ

任意のセッションを開き、すべてのターンを実際に発生した通りにステップ実行できます。リプレイビューは生テキストを超えて、各アシスタントターンの内部構造を表示します：

- **ツール呼び出し**: `Bash`、`Read`、`Edit`、`Write` やカスタムツール呼び出しを展開し、正確な入力引数とモデルが受け取った完全な出力を表示
- **サブエージェント生成**: Claude Code や OpenClaw がサブエージェントを起動すると、ダッシュボードはネストされたエージェントツリーをレンダリングし、どのサブタスクが委任されたか、どんな指示を受け取ったか、何を返したかを追跡
- **注入コンテキストとシステムイベント**: 通常はターン間に存在する隠れたコンテキストブロック、権限プロンプト、合成メッセージを表示
- **ターンごとのトークン計算**: input、output、cache-read、cache-write、reasoning トークン数をターンレベルで表示

### コーディングエージェントに過去のセッションを検索させる

Agent Trail には、AI コーディングエージェント（Claude Code、Codex など）がローカルの ingest/BFF API を通じて過去のセッションを見つける方法を教える、組み込みのエージェント skill **`local-session-search`** が同梱されています —— セッション ID を事前に知らなくても構いません。

- *「WebSocket 再接続のバグをデバッグしたセッションを探して」* のようにエージェントに尋ねられます。
- skill はメッセージ本文のグローバル検索（`GET /api/v1/sessions/search`）で候補セッションを洗い出し、セッション詳細 / ターン / メッセージへドリルダウンして回答します。
- `source`、`sessionId`、タイトル、プロジェクト、`updatedAt`、一致したスニペットなど、エージェントが正しいセッションを特定して開くのに十分なメタデータを返します。

この skill は [`.agents/skills/local-session-search/SKILL.md`](.agents/skills/local-session-search/SKILL.md) にあります。

---

## インストール

### 方法1 — npm（推奨、Node.js 22 以上）

```bash
npm install -g @camtrik/agent-trail
agent-trail
```

既存のグローバルインストールの更新：

```bash
npm update -g @camtrik/agent-trail
# または最新の公開バージョンを強制インストール：
npm install -g @camtrik/agent-trail@latest
```

Node 22、24 以降で動作 — `npm install` がローカル ABI に合わせたネイティブモジュール（better-sqlite3）を解決します。初回インストールは依存関係の取得に約 30 秒かかります。

実行時ログはデフォルトで静かです。詳細な診断情報が必要な場合：

```bash
AGENT_TRAIL_LOG_LEVEL=debug agent-trail
```

### 方法2 — Docker ローカルビルド

```bash
git clone https://github.com/camtrik/agent-trail.git
cd agent-trail
docker compose up --build
```

デフォルトの Compose ファイルは Docker 内で Node 24 を使用してアプリをローカルビルドするため、ホストマシンに Node.js をインストールする必要はありません。

[http://localhost:3030](http://localhost:3030) を開きます。

### 方法3 — Docker 公開イメージ

```bash
docker compose -f docker-compose.image.yml up -d
```

または公開イメージを直接実行：

```bash
docker run --rm -p 127.0.0.1:3030:3030 \
  -v "$HOME/.claude/projects:/agents/claude:ro" \
  -e CLAUDE_PROJECTS_DIR=/agents/claude \
  ghcr.io/camtrik/agent-trail:latest
```

[http://localhost:3030](http://localhost:3030) を開きます。`-v` と対応する環境変数（`OPENCLAW_DIR`、`CODEX_SESSIONS_DIR`、`OPENCODE_DB_PATH`）で追加のエージェントディレクトリをマウントします。

### 方法4 — ソースから

```bash
pnpm install
pnpm dev       # Next.js (3029) + インジェストサービス (8078) を起動
```

完全なセットアップと環境変数リファレンスは [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) を参照してください。

---

## アンインストール

### npm グローバルインストール

```bash
npm uninstall -g @camtrik/agent-trail
```

パッケージアプリが作成したローカルインデックス/設定のクリーンアップ（任意）：

```bash
rm -rf ~/.agent-trail
```

この操作は元の Claude Code、OpenClaw、Codex、OpenCode、Qoder のセッションファイルを削除しません。

### Docker Compose

コンテナの停止と削除：

```bash
docker compose down
# 公開イメージの compose ファイルを使用した場合：
docker compose -f docker-compose.image.yml down
```

ダッシュボードの SQLite インデックスを保存する Docker ボリュームのクリーンアップ（任意）：

```bash
docker compose down -v
# または：
docker compose -f docker-compose.image.yml down -v
```

イメージのクリーンアップ（任意）：

```bash
docker image rm agent-trail:local
docker image rm ghcr.io/camtrik/agent-trail:latest
```

---

## 対応 AI コーディングエージェント

| エージェント             | ソースファイル                                | 備考                                     |
| ------------------------ | --------------------------------------------- | ---------------------------------------- |
| **Claude Code**          | `~/.claude/projects/**/*.jsonl`               | 完全なツール呼び出しとサブエージェントリプレイ |
| **OpenClaw** | `~/.openclaw/agents/*/agent/openclaw-agent.sqlite` + アーカイブ JSONL | 稼働中の SQLite と旧アーカイブ |
| **Codex**                | `~/.codex/sessions/**/*.jsonl`                | 親子セッションツリー                     |
| **OpenCode** | `~/.local/share/opencode/opencode.db` | 旧形式と v2 SQLite スキーマ |
| **Qoder** | 旧 IDE のローカルキャッシュ DB | 現行 IDE/Desktop/CLI は追加検証が必要 |
| **Command Code** | `~/.commandcode/projects/**/*.jsonl` | v3 履歴と記録コスト。子エージェント内部履歴は復元できない場合あり |

---

## ユースケース

Agent Trail は以下のような場合に役立ちます：

- **Claude Code** のツール呼び出し、サブエージェントツリー、注入コンテキストの調査
- **Codex**、**OpenCode**、**OpenClaw**、**Qoder** のコーディングセッションをターンごとにリプレイ
- 複数のエージェントにわたる **LLM トークン使用量と推定コスト** のローカル追跡
- 最もトークンを消費したセッションやプロジェクトの分析
- 高コストまたは失敗した AI コーディングエージェント実行のデバッグ
---

## 互換性とライセンス

ソース開発は Node.js 24、pnpm 11.1.3、フロントエンド 3029、ingest 8078 を使用します。npm/Docker のフロントエンドは 3030 です。両サービスが継承するよう、INGEST_PORT は親シェルで設定してください。

検証済み形式、保存方式の制限、再インデックス手順は[互換性一覧](docs/en-US/COMPATIBILITY.md)を参照してください。この保守バッチは v0.2.0 向けです。既存の v0.1.7 からアップグレードする必要があります。

プロジェクト独自のソース、文書、ブランド素材には [MIT ライセンス](LICENSE) が適用されます。第三者の依存パッケージには各ライセンスが適用されます。

---

## プライバシー

これは**完全ローカル**なツールです。データがマシンから外部に出ることはありません。

- JSONL ファイルは解析され、ローカル SQLite データベース（`data/ingest.db`）にインデックス化されます。
- ダッシュボードは読み取り専用 — 記録されたツール呼び出しをリプレイするだけで、再実行はしません。
---


